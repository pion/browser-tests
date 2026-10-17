// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

const maxRTPObservations = 256
const maxRTPObservationLimit = 4096

type redSourceOptions struct {
	Tracks int `json:"tracks"`
}

type observedRTP struct {
	SSRC           uint32 `json:"ssrc"`
	SequenceNumber uint16 `json:"sequenceNumber"`
	Timestamp      uint32 `json:"timestamp"`
	PayloadType    uint8  `json:"payloadType"`
	Payload        []byte `json:"payload"`
	Padding        bool   `json:"padding,omitempty"`
	PaddingSize    uint8  `json:"paddingSize,omitempty"`
}

type rtpSnapshot struct {
	Inbound         []observedRTP `json:"inbound"`
	Outbound        []observedRTP `json:"outbound"`
	Application     []observedRTP `json:"application"`
	Source          []observedRTP `json:"source"`
	DroppedOutbound []observedRTP `json:"droppedOutbound"`
	Errors          []string      `json:"errors"`
	Truncated       bool          `json:"truncated"`
	SourceDone      bool          `json:"sourceDone"`
}

// RED peers retain a bounded prefix; ordinary peers have no recorder.
type rtpRecorder struct {
	mu                 sync.Mutex
	observation        rtpSnapshot
	startWithRED       bool
	observationLimit   int
	sourceTracks       int
	startupSuppressed  bool
	sourcesCompleted   int
	activeMediaReaders int
	activeMediaWriters int
}

func newRTPRecorder(startWithRED bool, observationLimit int, source *redSourceOptions) (*rtpRecorder, error) {
	tracks := 1
	if source != nil && source.Tracks != 0 {
		tracks = source.Tracks
	}
	if tracks < 1 || tracks > 2 {
		return nil, errors.New("redSource tracks must be between 1 and 2")
	}
	if observationLimit == 0 {
		observationLimit = maxRTPObservations
	}
	if observationLimit < 1 || observationLimit > maxRTPObservationLimit {
		return nil, fmt.Errorf("observationLimit must be between 1 and %d", maxRTPObservationLimit)
	}

	return &rtpRecorder{startWithRED: startWithRED, observationLimit: observationLimit, sourceTracks: tracks}, nil
}

func observeRTP(header *rtp.Header, payload []byte) observedRTP {
	return observedRTP{
		SSRC: header.SSRC, SequenceNumber: header.SequenceNumber, Timestamp: header.Timestamp,
		PayloadType: header.PayloadType, Payload: append([]byte{}, payload...),
		Padding: header.Padding, PaddingSize: header.PaddingSize,
	}
}

func (r *rtpRecorder) record(target *[]observedRTP, header *rtp.Header, payload []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recordLocked(target, header, payload)
}

func (r *rtpRecorder) recordLocked(target *[]observedRTP, header *rtp.Header, payload []byte) {
	limit := r.observationLimit
	if limit == 0 {
		limit = maxRTPObservations
	}
	if len(*target) >= limit {
		r.observation.Truncated = true

		return
	}
	*target = append(*target, observeRTP(header, payload))
}

// Suppress the first plain Opus carrier after encoding so the next carrier is RED.
func (r *rtpRecorder) suppressStartupOpus(header *rtp.Header, payload []byte, opusPayloadType uint8) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.startWithRED || r.startupSuppressed || header.Padding || len(payload) == 0 || header.PayloadType != opusPayloadType {
		return false
	}
	r.startupSuppressed = true
	r.recordLocked(&r.observation.DroppedOutbound, header, payload)

	return true
}

func (r *rtpRecorder) recordError(err error) {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.observation.Errors) < 8 {
		r.observation.Errors = append(r.observation.Errors, err.Error())
	}
}

func (r *rtpRecorder) snapshot() rtpSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	clone := func(packets []observedRTP) []observedRTP {
		result := append([]observedRTP{}, packets...)
		for index := range result {
			result[index].Payload = append([]byte{}, result[index].Payload...)
		}

		return result
	}
	return rtpSnapshot{
		Inbound:         clone(r.observation.Inbound),
		Outbound:        clone(r.observation.Outbound),
		Application:     clone(r.observation.Application),
		Source:          clone(r.observation.Source),
		DroppedOutbound: clone(r.observation.DroppedOutbound),
		Errors:          append([]string{}, r.observation.Errors...),
		Truncated:       r.observation.Truncated,
		SourceDone:      r.observation.SourceDone,
	}
}

func (r *rtpRecorder) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	return &rtpObserver{recorder: r}, nil
}

type rtpObserver struct {
	interceptor.NoOp
	recorder *rtpRecorder
}

func (o *rtpObserver) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	if !strings.EqualFold(info.MimeType, "audio/opus") {
		return writer
	}

	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if o.recorder.suppressStartupOpus(header, payload, uint8(info.PayloadType)) {
			return header.MarshalSize() + len(payload), nil
		}
		o.recorder.record(&o.recorder.observation.Outbound, header, payload)
		n, err := writer.Write(header, payload, attributes)
		o.recorder.recordError(err)

		return n, err
	})
}

func (o *rtpObserver) BindRemoteStream(info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	if !strings.EqualFold(info.MimeType, "audio/opus") {
		return reader
	}
	return interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		n, attributes, err := reader.Read(buffer, attributes)
		if err != nil {
			o.recorder.recordError(err)

			return n, attributes, err
		}
		var packet rtp.Packet
		if parseErr := packet.Unmarshal(buffer[:n]); parseErr != nil {
			o.recorder.recordError(parseErr)
		} else {
			o.recorder.record(&o.recorder.observation.Inbound, &packet.Header, packet.Payload)
		}

		return n, attributes, nil
	})
}
