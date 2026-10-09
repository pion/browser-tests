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

func TestREDControlsKeepLossAndCompletionSeparate(t *testing.T) {
	sequence, timestamp, interval := uint16(65534), uint32(4294966336), 0
	source := &redSourceOptions{
		Packets: 3, Trailers: 2, SequenceStart: &sequence, TimestampStart: &timestamp, IntervalMS: &interval,
	}
	recorder, err := newRTPRecorder(false, 16, source, &redImpairmentOptions{OutboundDrop: []int{0, 1}})
	require.NoError(t, err)
	observer := &rtpObserver{recorder: recorder}
	var wire [][]byte
	writer := observer.BindLocalStream(&interceptor.StreamInfo{MimeType: "audio/opus", PayloadType: 111},
		interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, _ interceptor.Attributes) (int, error) {
			raw, marshalErr := (&rtp.Packet{Header: *header, Payload: payload}).Marshal()
			wire = append(wire, raw)

			return len(raw), marshalErr
		}))
	for index := range 5 {
		header := recorder.source.header(index, 63, 42)
		written, writeErr := writer.Write(&header, []byte{111, 1}, nil)
		require.NoError(t, writeErr)
		require.Equal(t, header.MarshalSize()+2, written, "a deliberate drop must report a successful write")
	}
	sentinel := recorder.source.sentinel(111, 42)
	written, err := writer.Write(&sentinel.Header, sentinel.Payload, nil)
	require.NoError(t, err)
	require.Equal(t, sentinel.MarshalSize(), written)
	snapshot := recorder.snapshot()
	require.Len(t, snapshot.DroppedOutbound, 2)
	require.Equal(t, uint16(65534), snapshot.DroppedOutbound[0].SequenceNumber)
	require.Equal(t, uint16(65535), snapshot.DroppedOutbound[1].SequenceNumber)
	require.Len(t, snapshot.Outbound, 4)
	require.Equal(t, uint16(0), snapshot.Outbound[0].SequenceNumber)
	require.Equal(t, uint32(960), snapshot.Outbound[0].Timestamp)
	require.True(t, snapshot.Outbound[3].Padding)
	require.False(t, snapshot.Drained)

	// Ordinary padding cannot masquerade as the finite-source end marker.
	ordinaryPadding := sentinel
	ordinaryPadding.Marker = false
	require.False(t, recorder.isDrainSentinel(&ordinaryPadding, 111, 42))
	reads := 0
	reader := observer.BindRemoteStream(&interceptor.StreamInfo{MimeType: "audio/opus", PayloadType: 111, SSRC: 42},
		interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
			reads++
			if reads > 1 {
				return 0, attributes, io.EOF
			}

			return copy(buffer, wire[len(wire)-1]), attributes, nil
		}))
	_, _, err = reader.Read(make([]byte, 1500), nil)
	require.NoError(t, err)
	require.False(t, recorder.snapshot().Drained, "observing the sentinel cannot acknowledge decoding it")
	_, _, err = reader.Read(make([]byte, 1500), nil)
	require.ErrorIs(t, err, io.EOF)
	require.True(t, recorder.snapshot().Drained)
	require.Len(t, recorder.snapshot().Inbound, 1)
}

func TestREDControlBoundsAndDefaults(t *testing.T) {
	defaults, err := newRTPRecorder(false, 0, nil, nil)
	require.NoError(t, err)
	require.Equal(t, 256, defaults.source.packets)
	require.Equal(t, 20, defaults.source.intervalMS)
	require.False(t, defaults.source.controlled, "existing direction tests must not gain a sentinel")
	_, err = newRTPRecorder(false, maxRTPObservationLimit+1, nil, nil)
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, &redSourceOptions{Packets: 4095, Trailers: 2}, nil)
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, nil, &redImpairmentOptions{OutboundDrop: []int{256}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, nil, &redImpairmentOptions{OutboundDrop: []int{1, 1}})
	require.ErrorIs(t, err, errInvalidREDControl)
	bounded, err := newRTPRecorder(false, 1, nil, nil)
	require.NoError(t, err)
	for range 2 {
		bounded.record(&bounded.observation.Source, &rtp.Header{}, []byte{1})
	}
	require.Len(t, bounded.snapshot().Source, 1)
	require.True(t, bounded.snapshot().Truncated)
}
