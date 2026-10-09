// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"testing"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

func TestREDToneFixture(t *testing.T) {
	packets, err := readREDTone()
	require.NoError(t, err)
	require.Len(t, packets, redAudioPacketCount)
	// oggreader returns whole page payloads. Check lacing so a page cannot hide
	// multiple packets which would become a single invalid RTP payload.
	position := 0
	for index := range redAudioPacketCount + 2 {
		require.GreaterOrEqual(t, len(redAudioTone)-position, 28)
		segments := int(redAudioTone[position+26])
		require.Equal(t, 1, segments, "page %d", index)
		packetLength := int(redAudioTone[position+27])
		if index >= 2 {
			require.Equal(t, 160, packetLength, "page %d", index)
		}
		position += 27 + segments + packetLength
	}
}

func TestREDStartupSuppressesOnlyInitialOpus(t *testing.T) {
	recorder := &rtpRecorder{startWithRED: true}
	observer := &rtpObserver{recorder: recorder}
	var transmitted []uint16
	writer := observer.BindLocalStream(&interceptor.StreamInfo{MimeType: "audio/opus", PayloadType: 111},
		interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, _ interceptor.Attributes) (int, error) {
			transmitted = append(transmitted, header.SequenceNumber)

			return header.MarshalSize() + len(payload), nil
		}))
	for index, payloadType := range []uint8{111, 63, 111} {
		header := &rtp.Header{Version: 2, PayloadType: payloadType, SequenceNumber: uint16(1000 + index)}
		written, err := writer.Write(header, []byte{1, 2}, nil)
		require.NoError(t, err)
		require.Equal(t, header.MarshalSize()+2, written)
	}
	require.Equal(t, []uint16{1001, 1002}, transmitted)
	snapshot := recorder.snapshot()
	require.Len(t, snapshot.DroppedOutbound, 1)
	require.Equal(t, uint16(1000), snapshot.DroppedOutbound[0].SequenceNumber)
	require.Len(t, snapshot.Outbound, 2)
	require.Empty(t, snapshot.Errors)
}
