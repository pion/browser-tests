// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

const redAudioPacketCount = 256

// Generated once with ffmpeg 8.1.1; no encoder is needed when tests run:
//
//	ffmpeg -hide_banner -loglevel error -f lavfi \
//	  -i 'sine=frequency=440:sample_rate=48000:duration=6' -af volume=1.6 -ac 2 \
//	  -c:a libopus -b:a 64k -frame_duration 20 -vbr off -page_duration 20000 \
//	  -map_metadata -1 -fflags +bitexact -flags:a +bitexact internal/testserver/testdata/tone.opus
//
// The sine source has amplitude 0.125, scaled to 0.2 before stereo conversion.
//
//go:embed testdata/tone.opus
var redAudioTone []byte //nolint:gochecknoglobals // Embedded, immutable media fixture.

var ( //nolint:gochecknoglobals
	errREDToneShape    = errors.New("RED tone must contain stereo 48 kHz Opus, one 20 ms frame per page")
	errREDToneEncoding = errors.New("RED tone sender has no negotiated encoding")
)

func readREDTone() ([][]byte, error) {
	reader, header, err := oggreader.NewWith(bytes.NewReader(redAudioTone))
	if err != nil {
		return nil, err
	}
	if header.Channels != 2 || header.SampleRate != 48000 {
		return nil, errREDToneShape
	}
	tags, _, err := reader.ParseNextPage()
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(tags, []byte("OpusTags")) {
		return nil, errREDToneShape
	}
	packets := make([][]byte, 0, redAudioPacketCount)
	for index := range redAudioPacketCount {
		payload, page, readErr := reader.ParseNextPage()
		if readErr != nil {
			return nil, readErr
		}
		// Fixed 64 kbit/s, 20 ms CELT packets; code 0 contains exactly one frame.
		if len(payload) != 160 || payload[0]>>3 != 31 || payload[0]&3 != 0 ||
			page.GranulePosition != uint64(index+1)*960 {
			return nil, errREDToneShape
		}
		packets = append(packets, payload)
	}

	return packets, nil
}

func redAudioSend(pc *webrtc.PeerConnection, observation *rtpRecorder) (func(webrtc.PeerConnectionState), error) {
	packets, err := readREDTone()
	if err != nil {
		return nil, err
	}
	var handlers []func(webrtc.PeerConnectionState)
	for index := range observation.source.tracks {
		handler, setupErr := redAudioSendTrack(pc, observation, packets, index)
		if setupErr != nil {
			return nil, setupErr
		}
		handlers = append(handlers, handler)
	}

	return func(state webrtc.PeerConnectionState) {
		for _, handler := range handlers {
			handler(state)
		}
	}, nil
}

func redAudioSendTrack(pc *webrtc.PeerConnection, observation *rtpRecorder, packets [][]byte, trackIndex int) (func(webrtc.PeerConnectionState), error) {
	configuration := observation.source
	if configuration.packets == 0 {
		configuration, _ = sourceConfig(nil)
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, fmt.Sprintf("tone-%d", trackIndex), "red-audio",
	)
	if err != nil {
		return nil, err
	}
	transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		return nil, err
	}
	sender := transceiver.Sender()
	audio := &redAudioTrack{track: track, sender: sender, toneOffset: trackIndex * redAudioPacketCount / 2}
	observation.mu.Lock()
	observation.audioSenders = append(observation.audioSenders, audio)
	observation.mu.Unlock()
	readerDone := observation.mediaReader()
	go func() {
		defer readerDone()

		for {
			if _, _, readErr := sender.ReadRTCP(); readErr != nil {
				return
			}
		}
	}()
	connected, closed := make(chan struct{}), make(chan struct{})
	var startOnce, closeOnce sync.Once
	observation.sourceStarted()
	go func() {
		completed := false
		defer func() { observation.sourceFinished(completed) }()

		select {
		case <-connected:
		case <-closed:
			return
		}
		parameters := sender.GetParameters()
		if len(parameters.Encodings) == 0 {
			observation.recordError(errREDToneEncoding)

			return
		}
		var opusPayloadType uint8
		for _, codec := range parameters.Codecs {
			if strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus) {
				opusPayloadType = uint8(codec.PayloadType)
				break
			}
		}
		if opusPayloadType == 0 {
			observation.recordError(webrtc.ErrCodecNotFound)

			return
		}
		var tick <-chan time.Time
		if configuration.intervalMS > 0 {
			ticker := time.NewTicker(time.Duration(configuration.intervalMS) * time.Millisecond)
			defer ticker.Stop()
			tick = ticker.C
		}
		ssrc := uint32(parameters.Encodings[0].SSRC)
		for index := range configuration.packets + configuration.trailers {
			if tick == nil {
				select {
				case <-closed:
					return
				default:
				}
			} else {
				select {
				case <-closed:
					return
				case <-tick:
				}
			}
			packet := &rtp.Packet{
				Header: configuration.header(index, opusPayloadType, ssrc),
			}
			if writeErr := audio.write(observation, packet, packets, index); writeErr != nil {
				observation.recordError(writeErr)

				return
			}
		}
		if configuration.controlled {
			// No audio copies are carried by this final padding-only packet. It is
			// deliberately outside loss controls and absent from the source ledger.
			sentinel := configuration.sentinel(opusPayloadType, ssrc)
			if writeErr := audio.sentinel(&sentinel); writeErr != nil {
				observation.recordError(writeErr)

				return
			}
		}
		completed = true
	}()

	return func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			startOnce.Do(func() { close(connected) })
		case webrtc.PeerConnectionStateClosed:
			closeOnce.Do(func() { close(closed) })
		default:
		}
	}, nil
}

func redAudioReceive(pc *webrtc.PeerConnection, observation *rtpRecorder) error {
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		return err
	}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		defer observation.mediaReader()()
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				if observation.consumeInjectedError(err) {
					continue
				}
				observation.recordError(err)

				return
			}
			observation.record(&observation.observation.Application, &packet.Header, packet.Payload)
		}
	})

	return nil
}
