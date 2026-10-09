// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"testing"

	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

func TestREDStressObservationsContinueBeyondBoundedPrefix(t *testing.T) {
	recorder, err := newRTPRecorder(false, 2, &redSourceOptions{Stream: true, Packets: 70000, Trailers: 2}, nil)
	require.NoError(t, err)
	for index := range 70002 {
		header := recorder.source.header(index, 111, 42)
		payload := []byte{byte(index & 255)} //nolint:gosec // Deliberate fixture cycle.
		recorder.record(&recorder.observation.Source, &header, payload)
		recorder.record(&recorder.observation.Application, &header, payload)
		header.PayloadType = 63
		recorder.recordWire(&recorder.observation.Inbound, &header, payload, 63)
		recorder.recordWire(&recorder.observation.Outbound, &header, payload, 63)
	}
	snapshot := recorder.snapshot()
	require.True(t, snapshot.Truncated)
	for _, prefix := range [][]observedRTP{snapshot.Source, snapshot.Application, snapshot.Inbound, snapshot.Outbound} {
		require.Len(t, prefix, 2)
	}
	for _, direction := range []string{"source", "application", "inbound", "outbound", "inboundRED", "outboundRED"} {
		require.Equal(t, uint64(70002), snapshot.Totals[direction], direction)
	}
	source, delivered := snapshot.Summaries.Source["42"], snapshot.Summaries.Application["42"]
	require.Equal(t, source, delivered)
	require.Equal(t, uint64(70002), source.Count)
	require.Len(t, source.SHA256, 64)
	require.Equal(t, recorder.source.header(70001, 111, 42).SequenceNumber, source.LastSequenceNumber)
	require.Equal(t, recorder.source.header(70001, 111, 42).Timestamp, source.LastTimestamp)
	// Snapshots are detached; later progress cannot rewrite prior evidence.
	header := recorder.source.header(70002, 111, 42)
	recorder.record(&recorder.observation.Application, &header, []byte{1})
	require.Equal(t, uint64(70002), snapshot.Totals["application"])
	require.NotEqual(t, source, recorder.snapshot().Summaries.Application["42"])
}

func TestREDStressDigestDetectsLossDuplicatesReorderingAndCorruption(t *testing.T) {
	for _, change := range []string{"loss", "duplicate", "reorder", "sequence", "timestamp", "payload type", "payload"} {
		t.Run(change, func(t *testing.T) {
			recorder, err := newRTPRecorder(false, 1, &redSourceOptions{Stream: true, Packets: 3}, nil)
			require.NoError(t, err)
			packets := make([]rtp.Packet, 3)
			for index := range packets {
				packets[index] = rtp.Packet{Header: recorder.source.header(index, 111, 42), Payload: []byte{byte(index)}} //nolint:gosec // Three fixtures.
				recorder.record(&recorder.observation.Source, &packets[index].Header, packets[index].Payload)
			}
			order := []int{0, 1, 2}
			switch change {
			case "loss":
				order = []int{0, 2}
			case "duplicate":
				order = []int{0, 1, 1, 2}
			case "reorder":
				order = []int{0, 2, 1}
			case "sequence":
				packets[2].SequenceNumber++
			case "timestamp":
				packets[2].Timestamp++
			case "payload type":
				packets[2].PayloadType = 63
			case "payload":
				packets[2].Payload = []byte{99}
			}
			for _, index := range order {
				recorder.record(&recorder.observation.Application, &packets[index].Header, packets[index].Payload)
			}
			snapshot := recorder.snapshot()
			require.NotEqual(t, snapshot.Summaries.Source["42"].SHA256, snapshot.Summaries.Application["42"].SHA256,
				"every defect occurs after the retained prefix")
		})
	}
}

func TestREDStressSourceRejectsUnboundedFiniteControls(t *testing.T) {
	_, err := sourceConfig(&redSourceOptions{Packets: 70000, Trailers: 2})
	require.ErrorIs(t, err, errInvalidREDControl, "ordinary finite limits remain unchanged")
	_, err = sourceConfig(&redSourceOptions{Stream: true, Packets: 70001})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = sourceConfig(&redSourceOptions{Stream: true, Tracks: 2, Packets: 70000})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = sourceConfig(&redSourceOptions{Stream: true, Packets: 70000, PacketOverrides: []redPacketOverride{{Index: 0}}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, &redSourceOptions{Stream: true, Packets: 70000}, &redImpairmentOptions{InboundOrder: []int{0}})
	require.ErrorIs(t, err, errInvalidREDControl)
	_, err = newRTPRecorder(false, 512, &redSourceOptions{Stream: true, Packets: 70000}, &redImpairmentOptions{OutboundDrop: []int{0}})
	require.ErrorIs(t, err, errInvalidREDControl)
}
