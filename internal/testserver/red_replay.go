// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"fmt"
	"io"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

type redSourceIdentity struct {
	sequenceNumber uint16
	timestamp      uint32
}

type rtpAction struct {
	Kind    string `json:"kind"`
	Ordinal int    `json:"ordinal"`
}

type redBufferedPacket struct {
	raw        []byte
	attributes interceptor.Attributes
}

// Finite replay happens after decryption, preserving SRTP replay protection.
type redOrderedReader struct {
	recorder        *rtpRecorder
	reader          interceptor.RTPReader
	ssrc            uint32
	opusPayloadType uint8
	identities      map[redSourceIdentity]int
	originals       []*redBufferedPacket
	sentinel        *redBufferedPacket
	ready           bool
	cursor          int
	presented       map[int]bool
}

func newREDOrderedReader(recorder *rtpRecorder, info *interceptor.StreamInfo, reader interceptor.RTPReader) *redOrderedReader {
	count := recorder.source.packets + recorder.source.trailers
	identities := make(map[redSourceIdentity]int, count)
	for ordinal := range count {
		header := recorder.source.header(ordinal, uint8(info.PayloadType), info.SSRC)
		identities[redSourceIdentity{header.SequenceNumber, header.Timestamp}] = ordinal
	}

	return &redOrderedReader{
		recorder: recorder, reader: reader, ssrc: info.SSRC, opusPayloadType: uint8(info.PayloadType),
		identities: identities, originals: make([]*redBufferedPacket, count), presented: make(map[int]bool),
	}
}

func replayAttributes(attributes interceptor.Attributes) interceptor.Attributes {
	if attributes == nil {
		return nil
	}
	cloned := make(interceptor.Attributes, len(attributes))
	for key, value := range attributes {
		// Older interceptor builds have no public cache-clearing API. Cached
		// headers may reference reused buffers; reparse the actual replay bytes.
		if _, headerCache := value.(*rtp.Header); !headerCache {
			cloned[key] = value
		}
	}

	return cloned
}

func (r *rtpRecorder) recordAction(kind string, ordinal int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	limit := r.observationLimit
	if limit == 0 {
		limit = maxRTPObservations
	}
	if len(r.observation.InboundActions) >= 4*limit {
		r.observation.Truncated = true

		return
	}
	r.observation.InboundActions = append(r.observation.InboundActions, rtpAction{Kind: kind, Ordinal: ordinal})
}

func (r *redOrderedReader) bufferOriginals(buffer []byte, attributes interceptor.Attributes) error {
	for readCount := 0; readCount < maxRTPObservationLimit; readCount++ {
		n, receivedAttributes, err := r.reader.Read(buffer, attributes)
		if err != nil {
			return err
		}
		var packet rtp.Packet
		if err := packet.Unmarshal(buffer[:n]); err != nil {
			return err
		}
		r.recorder.record(&r.recorder.observation.InboundOriginal, &packet.Header, packet.Payload)
		retained := &redBufferedPacket{
			raw: append([]byte{}, buffer[:n]...), attributes: replayAttributes(receivedAttributes),
		}
		if r.recorder.isDrainSentinel(&packet, r.opusPayloadType, r.ssrc) {
			r.sentinel = retained
			selected := make(map[int]bool)
			for _, ordinal := range r.recorder.inboundOrder {
				if r.originals[ordinal] == nil {
					return fmt.Errorf("%w: requested source ordinal %d did not arrive", errInvalidREDControl, ordinal)
				}
				selected[ordinal] = true
			}
			for ordinal, original := range r.originals {
				if original != nil && !selected[ordinal] {
					r.recorder.recordAction("drop", ordinal)
				}
			}
			r.ready = true

			return nil
		}
		ordinal, known := r.identities[redSourceIdentity{packet.SequenceNumber, packet.Timestamp}]
		if packet.SSRC != r.ssrc || !known || r.originals[ordinal] != nil {
			return fmt.Errorf("%w: unexpected or repeated incoming source identity", errInvalidREDControl)
		}
		r.originals[ordinal] = retained
		r.recorder.recordAction("hold", ordinal)
	}

	return fmt.Errorf("%w: finite replay did not reach its sentinel within the packet bound", errInvalidREDControl)
}

func (r *redOrderedReader) Read(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
	if !r.ready {
		if err := r.bufferOriginals(buffer, attributes); err != nil {
			return 0, attributes, err
		}
	}
	var retained *redBufferedPacket
	if r.cursor < len(r.recorder.inboundOrder) {
		retained = r.originals[r.recorder.inboundOrder[r.cursor]]
	} else if r.sentinel != nil {
		retained = r.sentinel
	} else {
		return r.reader.Read(buffer, attributes)
	}
	if len(buffer) < len(retained.raw) {
		return 0, attributes, io.ErrShortBuffer
	}
	if r.cursor < len(r.recorder.inboundOrder) {
		ordinal := r.recorder.inboundOrder[r.cursor]
		kind := "release"
		if r.presented[ordinal] {
			kind = "duplicate"
		}
		r.recorder.recordAction(kind, ordinal)
		r.presented[ordinal] = true
		r.cursor++
	} else {
		r.sentinel = nil
	}

	return copy(buffer, retained.raw), replayAttributes(retained.attributes), nil
}
