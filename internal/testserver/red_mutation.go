// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"fmt"
	"io"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// Payload mutations occur only after SRTP authentication, immediately before
// RED decoding. Each mutation declares the exact decoder error it must produce.
func newREDMutationReader(recorder *rtpRecorder, info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	identities := make(map[redSourceIdentity]int)
	for ordinal := range recorder.source.packets + recorder.source.trailers {
		header := recorder.source.header(ordinal, uint8(info.PayloadType), info.SSRC)
		identities[redSourceIdentity{header.SequenceNumber, header.Timestamp}] = ordinal
	}

	return interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		recorder.mu.Lock()
		missing := recorder.pendingInjectedError
		recorder.pendingInjectedError = ""
		recorder.mu.Unlock()
		if missing != "" {
			return 0, attributes, fmt.Errorf("%w: malformed carrier did not produce expected error %q", errInvalidREDControl, missing)
		}
		n, attributes, err := reader.Read(buffer, attributes)
		if err != nil {
			return n, attributes, err
		}
		var packet rtp.Packet
		if err := packet.Unmarshal(buffer[:n]); err != nil {
			return 0, attributes, err
		}
		if recorder.inboundOrder == nil {
			recorder.record(&recorder.observation.InboundOriginal, &packet.Header, packet.Payload)
		}
		ordinal, known := identities[redSourceIdentity{packet.SequenceNumber, packet.Timestamp}]
		mutation, selected := recorder.inboundPayloads[ordinal]
		if packet.SSRC != info.SSRC || !known || !selected {
			return n, attributes, nil
		}
		packet.Payload = mutation.Payload
		raw, err := packet.Marshal()
		if err != nil {
			return 0, attributes, err
		}
		if len(raw) > len(buffer) {
			return 0, attributes, io.ErrShortBuffer
		}
		recorder.recordAction("mutate", ordinal)
		recorder.mu.Lock()
		recorder.pendingInjectedError = mutation.ExpectedError
		recorder.mu.Unlock()

		return copy(buffer, raw), replayAttributes(attributes), nil
	})
}

func (r *rtpRecorder) consumeInjectedError(err error) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingInjectedError == "" || err.Error() != r.pendingInjectedError {
		return false
	}
	r.pendingInjectedError = ""
	if len(r.observation.InjectedErrors) < 8 {
		r.observation.InjectedErrors = append(r.observation.InjectedErrors, err.Error())
	} else {
		r.observation.Truncated = true
	}

	return true
}
