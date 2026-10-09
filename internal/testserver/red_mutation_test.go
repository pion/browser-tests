// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"io"
	"testing"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

func TestREDMutationRequiresTheDeclaredDecoderError(t *testing.T) {
	const expected = "invalid RED payload: malformed RED payload: truncated redundant block header"
	recorder, err := newRTPRecorder(false, 16, &redSourceOptions{Packets: 2}, &redImpairmentOptions{
		InboundPayloads: []redPayloadMutation{{Index: 1, Payload: []byte{0xef}, ExpectedError: expected}},
	})
	require.NoError(t, err)
	original := rtp.Packet{Header: recorder.source.header(1, 63, 42), Payload: []byte{111, 1}}
	raw, err := original.Marshal()
	require.NoError(t, err)
	attributes := interceptor.Attributes{"preserved": true}
	_, err = attributes.GetRTPHeader(raw)
	require.NoError(t, err)
	reader := newREDMutationReader(recorder, &interceptor.StreamInfo{PayloadType: 111, SSRC: 42},
		interceptor.RTPReaderFunc(func(buffer []byte, _ interceptor.Attributes) (int, interceptor.Attributes, error) {
			return copy(buffer, raw), attributes, nil
		}))
	buffer := make([]byte, 1500)
	n, receivedAttributes, err := reader.Read(buffer, nil)
	require.NoError(t, err)
	var mutated rtp.Packet
	require.NoError(t, mutated.Unmarshal(buffer[:n]))
	require.Equal(t, []byte{0xef}, mutated.Payload)
	require.Equal(t, original.SequenceNumber, mutated.SequenceNumber)
	require.True(t, receivedAttributes["preserved"].(bool))
	require.False(t, recorder.consumeInjectedError(io.ErrUnexpectedEOF), "a transport failure cannot consume the injection allowance")
	require.True(t, recorder.consumeInjectedError(errors.New(expected)))
	require.False(t, recorder.consumeInjectedError(errors.New(expected)), "one mutation allows exactly one matching error")
	snapshot := recorder.snapshot()
	require.Equal(t, original.Payload, snapshot.InboundOriginal[0].Payload)
	require.Equal(t, []rtpAction{{"mutate", 1}}, snapshot.InboundActions)
	require.Equal(t, []string{expected}, snapshot.InjectedErrors)
	require.Empty(t, snapshot.Errors)
	_, _, err = reader.Read(buffer, nil)
	require.NoError(t, err)
	_, _, err = reader.Read(buffer, nil)
	require.ErrorIs(t, err, errInvalidREDControl, "accepting malformed media silently fails before a subsequent raw read")
}

func TestREDPacketHeaderControlsAndBounds(t *testing.T) {
	configuration, err := sourceConfig(&redSourceOptions{Packets: 2, PacketOverrides: []redPacketOverride{{
		Index: 1, CSRC: []uint32{0x11223344, 0x55667788}, PaddingSize: 4,
		Extensions: []redHeaderExtension{{ID: 7, Payload: []byte{0xaa, 0xbb}}},
	}}})
	require.NoError(t, err)
	header := configuration.header(1, 111, 42)
	require.Equal(t, 28, header.MarshalSize())
	raw, err := (&rtp.Packet{Header: header, Payload: []byte{1, 2, 3}}).Marshal()
	require.NoError(t, err)
	var packet rtp.Packet
	require.NoError(t, packet.Unmarshal(raw))
	observed := observeRTP(&packet.Header, packet.Payload)
	require.Equal(t, len(raw), observed.PacketSize)
	require.Equal(t, header.CSRC, observed.CSRC)
	require.Equal(t, []redHeaderExtension{{ID: 7, Payload: []byte{0xaa, 0xbb}}}, observed.Extensions)
	require.Equal(t, uint8(4), observed.PaddingSize)
	_, err = sourceConfig(&redSourceOptions{Packets: 2, PacketOverrides: []redPacketOverride{{Index: 0, CSRC: make([]uint32, 16)}}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = sourceConfig(&redSourceOptions{Packets: 2, PacketOverrides: []redPacketOverride{{Index: 0,
		Extensions: []redHeaderExtension{{ID: 7, Payload: []byte{1}}, {ID: 7, Payload: []byte{2}}},
	}}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 16, &redSourceOptions{Packets: 2}, &redImpairmentOptions{
		InboundPayloads: []redPayloadMutation{{Index: 1, Payload: []byte{0xef}, ExpectedError: "EOF"}},
	})
	require.ErrorIs(t, err, errInvalidREDControl, "transport errors cannot be declared expected decoder errors")
}
