// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"fmt"
	"strings"

	"github.com/pion/rtp"
)

const maxRTPObservationLimit = 4096

const maxREDStressPackets = 70000

type redSourceOptions struct {
	Stream          bool                `json:"stream"`
	Tracks          int                 `json:"tracks"`
	Packets         int                 `json:"packets"`
	Trailers        int                 `json:"trailers"`
	SequenceStart   *uint16             `json:"sequenceStart"`
	TimestampStart  *uint32             `json:"timestampStart"`
	IntervalMS      *int                `json:"intervalMs"`
	PacketOverrides []redPacketOverride `json:"packetOverrides"`
}

type redPacketOverride struct {
	Index          int                  `json:"index"`
	SequenceNumber *uint16              `json:"sequenceNumber"`
	Timestamp      *uint32              `json:"timestamp"`
	Payload        *[]byte              `json:"payload"`
	OpusFrames     int                  `json:"opusFrames"`
	CSRC           []uint32             `json:"csrc"`
	Extensions     []redHeaderExtension `json:"extensions"`
	PaddingSize    uint8                `json:"paddingSize"`
}

type redHeaderExtension struct {
	ID      uint8  `json:"id"`
	Payload []byte `json:"payload"`
}

type redPayloadMutation struct {
	Index         int    `json:"index"`
	Payload       []byte `json:"payload"`
	ExpectedError string `json:"expectedError"`
}

type redImpairmentOptions struct {
	OutboundDrop    []int                `json:"outboundDrop"`
	InboundOrder    []int                `json:"inboundOrder"`
	InboundPayloads []redPayloadMutation `json:"inboundPayloads"`
}

type redSourceConfig struct {
	stream          bool
	tracks          int
	packets         int
	trailers        int
	sequenceStart   uint16
	timestampStart  uint32
	intervalMS      int
	controlled      bool
	packetOverrides map[int]redPacketOverride
}

var errInvalidREDControl = errors.New("invalid RED test controls") //nolint:gochecknoglobals

func sourceConfig(options *redSourceOptions) (redSourceConfig, error) {
	configuration := redSourceConfig{
		tracks: 1, packets: redAudioPacketCount, sequenceStart: 1000, timestampStart: 48000, intervalMS: 20,
		controlled: options != nil,
	}
	if options == nil {
		return configuration, nil
	}
	if options.Packets != 0 {
		configuration.packets = options.Packets
	}
	if options.Tracks != 0 {
		configuration.tracks = options.Tracks
	}
	configuration.trailers = options.Trailers
	configuration.stream = options.Stream
	if options.SequenceStart != nil {
		configuration.sequenceStart = *options.SequenceStart
	}
	if options.TimestampStart != nil {
		configuration.timestampStart = *options.TimestampStart
	}
	if options.IntervalMS != nil {
		configuration.intervalMS = *options.IntervalMS
	}
	maximum := maxRTPObservationLimit - 1 - configuration.trailers
	if configuration.stream {
		maximum = maxREDStressPackets
	}
	if configuration.tracks < 1 || configuration.tracks > 2 ||
		configuration.packets < 1 || configuration.trailers < 0 || configuration.trailers > 2 ||
		configuration.packets > maximum ||
		(!configuration.stream && configuration.tracks*(configuration.packets+configuration.trailers+1) > maxRTPObservationLimit) ||
		configuration.intervalMS < 0 || configuration.intervalMS > 1000 {
		return redSourceConfig{}, fmt.Errorf("%w: require 1..%d media packets, 1..2 tracks, bounded finite observations, 0..2 trailers, intervalMs 0..1000",
			errInvalidREDControl, maximum)
	}
	if configuration.stream {
		if configuration.tracks != 1 || len(options.PacketOverrides) != 0 {
			return redSourceConfig{}, fmt.Errorf("%w: stress stream requires one track and no packet overrides", errInvalidREDControl)
		}
		// Constant 960-tick progression does not repeat source identities within
		// 70,002 packets, so no full source identity map is needed for this run.
		return configuration, nil
	}
	configuration.packetOverrides = make(map[int]redPacketOverride)
	for _, override := range options.PacketOverrides {
		_, duplicate := configuration.packetOverrides[override.Index]
		if override.Index < 0 || override.Index >= configuration.packets+configuration.trailers || duplicate ||
			(override.Payload != nil && len(*override.Payload) > 4096) || override.OpusFrames < 0 || override.OpusFrames > 3 ||
			(override.Payload != nil && override.OpusFrames != 0) {
			return redSourceConfig{}, fmt.Errorf("%w: invalid packet override at index %d", errInvalidREDControl, override.Index)
		}
		if override.SequenceNumber != nil {
			value := *override.SequenceNumber
			override.SequenceNumber = &value
		}
		if override.Timestamp != nil {
			value := *override.Timestamp
			override.Timestamp = &value
		}
		if override.Payload != nil {
			value := append([]byte{}, (*override.Payload)...)
			override.Payload = &value
		}
		if len(override.CSRC) > 15 {
			return redSourceConfig{}, fmt.Errorf("%w: RTP allows at most 15 CSRCs", errInvalidREDControl)
		}
		override.CSRC = append([]uint32(nil), override.CSRC...)
		override.Extensions = append([]redHeaderExtension(nil), override.Extensions...)
		extensionIDs := make(map[uint8]bool)
		for index, extension := range override.Extensions {
			if extension.ID < 1 || extension.ID > 14 || len(extension.Payload) < 1 || len(extension.Payload) > 16 || extensionIDs[extension.ID] {
				return redSourceConfig{}, fmt.Errorf("%w: require unique one-byte RTP extension IDs 1..14 and 1..16 payload bytes", errInvalidREDControl)
			}
			extensionIDs[extension.ID] = true
			override.Extensions[index].Payload = append([]byte(nil), extension.Payload...)
		}
		configuration.packetOverrides[override.Index] = override
	}
	identities := make(map[redSourceIdentity]bool)
	for index := range configuration.packets + configuration.trailers {
		header := configuration.header(index, 0, 0)
		identity := redSourceIdentity{header.SequenceNumber, header.Timestamp}
		if identities[identity] {
			return redSourceConfig{}, fmt.Errorf("%w: packet override repeats source identity at index %d", errInvalidREDControl, index)
		}
		identities[identity] = true
	}
	sentinel := configuration.sentinel(0, 0)
	if identities[redSourceIdentity{sentinel.SequenceNumber, sentinel.Timestamp}] {
		return redSourceConfig{}, fmt.Errorf("%w: completion sentinel overlaps a source identity", errInvalidREDControl)
	}

	return configuration, nil
}

func newRTPRecorder(
	startWithRED bool, observationLimit int, source *redSourceOptions, impairment *redImpairmentOptions,
) (*rtpRecorder, error) {
	configuration, err := sourceConfig(source)
	if err != nil {
		return nil, err
	}
	if observationLimit == 0 {
		observationLimit = maxRTPObservations
	}
	if observationLimit < 1 || observationLimit > maxRTPObservationLimit {
		return nil, fmt.Errorf("%w: observationLimit must be between 1 and %d", errInvalidREDControl, maxRTPObservationLimit)
	}
	recorder := &rtpRecorder{
		startWithRED: startWithRED, observationLimit: observationLimit, source: configuration,
		outboundDrop: make(map[int]bool),
	}
	if impairment != nil {
		if configuration.stream {
			return nil, fmt.Errorf("%w: stress stream does not support finite impairment controls", errInvalidREDControl)
		}
		if configuration.tracks > 1 {
			return nil, fmt.Errorf("%w: multi-track sources do not accept packet impairment controls", errInvalidREDControl)
		}
		recorder.source.controlled = true
		for _, ordinal := range impairment.OutboundDrop {
			if ordinal < 0 || ordinal >= configuration.packets+configuration.trailers || recorder.outboundDrop[ordinal] {
				return nil, fmt.Errorf("%w: outboundDrop contains invalid or repeated media ordinal %d", errInvalidREDControl, ordinal)
			}
			recorder.outboundDrop[ordinal] = true
		}
		if impairment.InboundOrder != nil {
			if source == nil || len(impairment.InboundOrder) >= maxRTPObservationLimit {
				return nil, fmt.Errorf("%w: inboundOrder requires an explicit bounded redSource", errInvalidREDControl)
			}
			for _, ordinal := range impairment.InboundOrder {
				if ordinal < 0 || ordinal >= configuration.packets+configuration.trailers {
					return nil, fmt.Errorf("%w: inboundOrder contains invalid source ordinal %d", errInvalidREDControl, ordinal)
				}
			}
			recorder.inboundOrder = append([]int{}, impairment.InboundOrder...)
		}
		if len(impairment.InboundPayloads) > 0 {
			if source == nil {
				return nil, fmt.Errorf("%w: inboundPayloads requires an explicit bounded redSource", errInvalidREDControl)
			}
			recorder.inboundPayloads = make(map[int]redPayloadMutation)
			for _, mutation := range impairment.InboundPayloads {
				_, duplicate := recorder.inboundPayloads[mutation.Index]
				decoderError := strings.HasPrefix(mutation.ExpectedError, "invalid RED payload:") ||
					strings.HasPrefix(mutation.ExpectedError, "unexpected RED primary payload type:") || mutation.ExpectedError == "RED primary payload is empty"
				if mutation.Index < 0 || mutation.Index >= configuration.packets+configuration.trailers || duplicate ||
					len(mutation.Payload) > 4096 || !decoderError {
					return nil, fmt.Errorf("%w: invalid inboundPayloads mutation at index %d", errInvalidREDControl, mutation.Index)
				}
				mutation.Payload = append([]byte{}, mutation.Payload...)
				recorder.inboundPayloads[mutation.Index] = mutation
			}
		}
	}

	return recorder, nil
}

func (source redSourceConfig) header(index int, payloadType uint8, ssrc uint32) rtp.Header {
	header := rtp.Header{
		Version: 2, PayloadType: payloadType, SSRC: ssrc,
		SequenceNumber: uint16((int(source.sequenceStart) + index) & 0xffff), //nolint:gosec // Deliberate RTP wrap.
		Timestamp:      source.timestampStart + uint32(index)*960,            //nolint:gosec // Packet count is bounded.
	}
	if override, ok := source.packetOverrides[index]; ok {
		if override.SequenceNumber != nil {
			header.SequenceNumber = *override.SequenceNumber
		}
		if override.Timestamp != nil {
			header.Timestamp = *override.Timestamp
		}
		header.CSRC = append([]uint32(nil), override.CSRC...)
		for _, extension := range override.Extensions {
			// Configuration validates the one-byte extension bounds above.
			_ = header.SetExtension(extension.ID, extension.Payload)
		}
		header.Padding, header.PaddingSize = override.PaddingSize != 0, override.PaddingSize
	}

	return header
}

func (source redSourceConfig) payload(index int, fallback []byte) []byte {
	if override, ok := source.packetOverrides[index]; ok {
		if override.Payload != nil {
			return *override.Payload
		}
		if override.OpusFrames > 1 {
			// Opus code 3 with VBR/padding bits clear carries equal-sized frames.
			// Each fixture packet is one 20 ms frame, so 2/3 frames are 40/60 ms.
			frame := fallback[1:]
			payload := make([]byte, 2+len(frame)*override.OpusFrames)
			payload[0], payload[1] = fallback[0]|3, byte(override.OpusFrames) //nolint:gosec // Count is validated 1..3.
			for frameIndex := range override.OpusFrames {
				copy(payload[2+frameIndex*len(frame):], frame)
			}

			return payload
		}
	}

	return fallback
}

func (source redSourceConfig) sentinel(payloadType uint8, ssrc uint32) rtp.Packet {
	header := source.header(source.packets+source.trailers-1, payloadType, ssrc)
	header.SequenceNumber++
	header.Timestamp += 960
	header.Padding, header.Marker, header.PaddingSize = true, true, 1

	return rtp.Packet{Header: header}
}

func (r *rtpRecorder) isDrainSentinel(packet *rtp.Packet, opusPayloadType uint8, ssrc uint32) bool {
	if !r.source.controlled {
		return false
	}
	expected := r.source.sentinel(opusPayloadType, ssrc)

	return packet.SSRC == expected.SSRC && packet.PayloadType == expected.PayloadType &&
		packet.SequenceNumber == expected.SequenceNumber && packet.Timestamp == expected.Timestamp &&
		packet.Padding && packet.PaddingSize == 1 && packet.Marker && len(packet.Payload) == 0
}
