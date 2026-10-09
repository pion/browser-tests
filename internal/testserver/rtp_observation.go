// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"io"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

const maxRTPObservations = 256

type observedRTP struct {
	SSRC           uint32               `json:"ssrc"`
	SequenceNumber uint16               `json:"sequenceNumber"`
	Timestamp      uint32               `json:"timestamp"`
	PayloadType    uint8                `json:"payloadType"`
	Payload        []byte               `json:"payload"`
	Padding        bool                 `json:"padding,omitempty"`
	PaddingSize    uint8                `json:"paddingSize,omitempty"`
	CSRC           []uint32             `json:"csrc,omitempty"`
	Extensions     []redHeaderExtension `json:"extensions,omitempty"`
	HeaderSize     int                  `json:"headerSize"`
	PacketSize     int                  `json:"packetSize"`
}

type rtpSnapshot struct {
	Totals             map[string]uint64 `json:"totals"`
	Summaries          rtpSummaries      `json:"summaries"`
	ActiveMediaReaders int               `json:"activeMediaReaders"`
	ActiveMediaWriters int               `json:"activeMediaWriters"`
	Inbound            []observedRTP     `json:"inbound"`
	InboundOriginal    []observedRTP     `json:"inboundOriginal"`
	InboundActions     []rtpAction       `json:"inboundActions"`
	Outbound           []observedRTP     `json:"outbound"`
	Application        []observedRTP     `json:"application"`
	Source             []observedRTP     `json:"source"`
	DroppedOutbound    []observedRTP     `json:"droppedOutbound"`
	Errors             []string          `json:"errors"`
	InjectedErrors     []string          `json:"injectedErrors"`
	Truncated          bool              `json:"truncated"`
	SourceDone         bool              `json:"sourceDone"`
	Drained            bool              `json:"drained"`
}

// RED peers retain a bounded prefix; ordinary peers have no recorder.
type rtpRecorder struct {
	statistics           rtpStatistics
	mu                   sync.Mutex
	observation          rtpSnapshot
	startWithRED         bool
	observationLimit     int
	source               redSourceConfig
	outboundDrop         map[int]bool
	outboundOrdinal      int
	startupSuppressed    bool
	inboundOrder         []int
	inboundPayloads      map[int]redPayloadMutation
	pendingInjectedError string
	audioSenders         []*redAudioTrack
	sourcesCompleted     int
}

func observeRTP(header *rtp.Header, payload []byte) observedRTP {
	observed := observedRTP{
		SSRC: header.SSRC, SequenceNumber: header.SequenceNumber, Timestamp: header.Timestamp,
		PayloadType: header.PayloadType, Payload: append([]byte{}, payload...),
		Padding: header.Padding, PaddingSize: header.PaddingSize,
		CSRC:       append([]uint32(nil), header.CSRC...),
		HeaderSize: header.MarshalSize(), PacketSize: header.MarshalSize() + len(payload) + int(header.PaddingSize),
	}
	for _, id := range header.GetExtensionIDs() {
		observed.Extensions = append(observed.Extensions, redHeaderExtension{ID: id, Payload: append([]byte{}, header.GetExtension(id)...)})
	}
	return observed
}

func (r *rtpRecorder) record(target *[]observedRTP, header *rtp.Header, payload []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recordLocked(target, header, payload)
}

func (r *rtpRecorder) recordLocked(target *[]observedRTP, header *rtp.Header, payload []byte) {
	r.recordStatisticsLocked(target, header, payload)
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

// Drops happen after encoding, retaining the missing audio in encoder history.
func (r *rtpRecorder) dropOutbound(header *rtp.Header, payload []byte, opusPayloadType uint8) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(payload) == 0 {
		return false
	}
	ordinal := r.outboundOrdinal
	r.outboundOrdinal++
	drop := r.outboundDrop[ordinal]
	if r.startWithRED && !r.startupSuppressed && !header.Padding && header.PayloadType == opusPayloadType {
		r.startupSuppressed = true
		drop = true
	}
	if !drop {
		return false
	}
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
	totals, summaries := r.statistics.snapshot()

	return rtpSnapshot{
		Totals: totals, Summaries: summaries,
		ActiveMediaReaders: r.observation.ActiveMediaReaders,
		ActiveMediaWriters: r.observation.ActiveMediaWriters,
		Inbound:            append([]observedRTP{}, r.observation.Inbound...),
		InboundOriginal:    append([]observedRTP{}, r.observation.InboundOriginal...),
		InboundActions:     append([]rtpAction{}, r.observation.InboundActions...),
		Outbound:           append([]observedRTP{}, r.observation.Outbound...),
		Application:        append([]observedRTP{}, r.observation.Application...),
		Source:             append([]observedRTP{}, r.observation.Source...),
		DroppedOutbound:    append([]observedRTP{}, r.observation.DroppedOutbound...),
		Errors:             append([]string{}, r.observation.Errors...), Truncated: r.observation.Truncated,
		InjectedErrors: append([]string{}, r.observation.InjectedErrors...),
		SourceDone:     r.observation.SourceDone, Drained: r.observation.Drained,
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
		if o.recorder.dropOutbound(header, payload, uint8(info.PayloadType)) {
			return header.MarshalSize() + len(payload), nil
		}
		o.recorder.recordWire(&o.recorder.observation.Outbound, header, payload, info.PayloadTypeForwardErrorCorrection)
		n, err := writer.Write(header, payload, attributes)
		o.recorder.recordError(err)

		return n, err
	})
}

func (o *rtpObserver) BindRemoteStream(info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	if !strings.EqualFold(info.MimeType, "audio/opus") {
		return reader
	}
	if o.recorder.inboundOrder != nil {
		reader = newREDOrderedReader(o.recorder, info, reader)
	}
	if len(o.recorder.inboundPayloads) > 0 {
		reader = newREDMutationReader(o.recorder, info, reader)
	}
	pendingDrain := false

	return interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		if pendingDrain {
			// RED requested another raw packet, so it consumed the sentinel and
			// emitted all pending application output without a decoding error.
			o.recorder.mu.Lock()
			o.recorder.observation.Drained = true
			o.recorder.mu.Unlock()
			pendingDrain = false
		}
		n, attributes, err := reader.Read(buffer, attributes)
		if err != nil {
			o.recorder.recordError(err)

			return n, attributes, err
		}
		var packet rtp.Packet
		if parseErr := packet.Unmarshal(buffer[:n]); parseErr != nil {
			o.recorder.recordError(parseErr)
		} else {
			o.recorder.recordWire(&o.recorder.observation.Inbound, &packet.Header, packet.Payload, info.PayloadTypeForwardErrorCorrection)
			pendingDrain = o.recorder.isDrainSentinel(&packet, uint8(info.PayloadType), info.SSRC)
		}

		return n, attributes, nil
	})
}
