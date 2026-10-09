// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"io"
	"testing"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

func TestREDOrderedReaderReplaysDecryptedCopies(t *testing.T) {
	recorder, err := newRTPRecorder(false, 32, &redSourceOptions{Packets: 4},
		&redImpairmentOptions{InboundOrder: []int{2, 0, 2, 1}})
	require.NoError(t, err)
	var originals [][]byte
	for ordinal := range 4 {
		packet := rtp.Packet{Header: recorder.source.header(ordinal, 111, 42), Payload: []byte{byte(ordinal + 1)}}
		raw, marshalErr := packet.Marshal()
		require.NoError(t, marshalErr)
		originals = append(originals, raw)
	}
	sentinel := recorder.source.sentinel(111, 42)
	raw, err := sentinel.Marshal()
	require.NoError(t, err)
	originals = append(originals, raw)
	sharedAttributes := interceptor.Attributes{}
	cachedHeader, err := sharedAttributes.GetRTPHeader(originals[0])
	require.NoError(t, err)
	reads := 0
	upstream := interceptor.RTPReaderFunc(func(buffer []byte, _ interceptor.Attributes) (int, interceptor.Attributes, error) {
		if reads == len(originals) {
			return 0, sharedAttributes, io.EOF
		}
		// Simulate a reader reusing its byte buffer and cached header metadata.
		n := copy(buffer, originals[reads])
		cachedHeader.SequenceNumber = uint16(1000 + reads)
		sharedAttributes["ordinal"] = reads
		reads++

		return n, sharedAttributes, nil
	})
	observer := &rtpObserver{recorder: recorder}
	reader := observer.BindRemoteStream(&interceptor.StreamInfo{MimeType: "audio/opus", PayloadType: 111, SSRC: 42}, upstream)
	buffer := make([]byte, 1500)
	for _, ordinal := range []int{2, 0, 2, 1, 4} {
		n, attributes, readErr := reader.Read(buffer, nil)
		require.NoError(t, readErr)
		require.Equal(t, originals[ordinal], buffer[:n])
		require.Equal(t, ordinal, attributes["ordinal"])
		header, headerErr := attributes.GetRTPHeader(buffer[:n])
		require.NoError(t, headerErr)
		require.Equal(t, uint16(1000+ordinal), header.SequenceNumber)
		attributes["ordinal"] = -1 // A duplicate gets fresh metadata.
	}
	require.False(t, recorder.snapshot().Drained)
	_, _, err = reader.Read(buffer, nil)
	require.ErrorIs(t, err, io.EOF)
	snapshot := recorder.snapshot()
	require.True(t, snapshot.Drained)
	require.Len(t, snapshot.InboundOriginal, 5)
	require.Len(t, snapshot.Inbound, 5)
	require.Equal(t, []rtpAction{
		{"hold", 0}, {"hold", 1}, {"hold", 2}, {"hold", 3}, {"drop", 3},
		{"release", 2}, {"release", 0}, {"duplicate", 2}, {"release", 1},
	}, snapshot.InboundActions)
	require.Empty(t, snapshot.Errors)
}

func TestREDOverridesValidateIdentitiesAndOpusDuration(t *testing.T) {
	packets, err := readREDTone()
	require.NoError(t, err)
	sequence, timestamp := uint16(65000), uint32(4294966000)
	configuration, err := sourceConfig(&redSourceOptions{Packets: 3, PacketOverrides: []redPacketOverride{
		{Index: 2, SequenceNumber: &sequence, Timestamp: &timestamp, OpusFrames: 3},
	}})
	require.NoError(t, err)
	header := configuration.header(2, 111, 42)
	require.Equal(t, sequence, header.SequenceNumber)
	require.Equal(t, timestamp, header.Timestamp)
	completion := configuration.sentinel(111, 42)
	require.Equal(t, sequence+1, completion.SequenceNumber)
	require.Equal(t, timestamp+960, completion.Timestamp)
	payload := configuration.payload(2, packets[2])
	require.Equal(t, packets[2][0]|3, payload[0])
	require.Equal(t, byte(3), payload[1])
	require.Len(t, payload, 479, "three 20 ms CBR frames are a genuine 60 ms Opus packet")
	for index := range 3 {
		require.Equal(t, packets[2][1:], payload[2+159*index:2+159*(index+1)])
	}
	_, err = newRTPRecorder(false, 512, nil, &redImpairmentOptions{InboundOrder: []int{0}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, &redSourceOptions{Packets: 3}, &redImpairmentOptions{InboundOrder: []int{3}})
	require.ErrorIs(t, err, errInvalidREDControl)
	duplicateSequence, duplicateTimestamp := uint16(1000), uint32(48000)
	_, err = sourceConfig(&redSourceOptions{Packets: 3, PacketOverrides: []redPacketOverride{
		{Index: 1, SequenceNumber: &duplicateSequence, Timestamp: &duplicateTimestamp},
	}})
	require.ErrorIs(t, err, errInvalidREDControl)
}
