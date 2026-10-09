// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"fmt"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var errREDAudioTrackIndex = errors.New("unknown RED audio sender index") //nolint:gochecknoglobals

// Replacement reuses the negotiated sender and SSRC. The lock serializes the
// replacement with application writes so the source ledger stays authoritative.
type redAudioTrack struct {
	mu         sync.Mutex
	track      *webrtc.TrackLocalStaticRTP
	sender     *webrtc.RTPSender
	toneOffset int
	generation int
}

func (audio *redAudioTrack) write(observation *rtpRecorder, packet *rtp.Packet, packets [][]byte, index int) error {
	audio.mu.Lock()
	defer audio.mu.Unlock()
	packet.Payload = observation.source.payload(index, packets[(index+audio.toneOffset)%len(packets)])
	observation.record(&observation.observation.Source, &packet.Header, packet.Payload)

	return audio.track.WriteRTP(packet)
}

func (audio *redAudioTrack) sentinel(packet *rtp.Packet) error {
	audio.mu.Lock()
	defer audio.mu.Unlock()

	return audio.track.WriteRTP(packet)
}

func (r *rtpRecorder) replaceAudioTrack(index int) error {
	r.mu.Lock()
	if index < 0 || index >= len(r.audioSenders) {
		r.mu.Unlock()

		return errREDAudioTrackIndex
	}
	audio := r.audioSenders[index]
	r.mu.Unlock()
	audio.mu.Lock()
	defer audio.mu.Unlock()
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		fmt.Sprintf("tone-%d-replacement-%d", index, audio.generation+1), "red-audio",
	)
	if err != nil {
		return err
	}
	if err = audio.sender.ReplaceTrack(track); err != nil {
		return err
	}
	audio.track, audio.toneOffset, audio.generation = track, audio.toneOffset+redAudioPacketCount/2, audio.generation+1

	return nil
}

func (r *rtpRecorder) mediaReader() func() {
	r.mu.Lock()
	r.observation.ActiveMediaReaders++
	r.mu.Unlock()

	return func() {
		r.mu.Lock()
		r.observation.ActiveMediaReaders--
		r.mu.Unlock()
	}
}

func (r *rtpRecorder) sourceStarted() {
	r.mu.Lock()
	r.observation.ActiveMediaWriters++
	r.mu.Unlock()
}

func (r *rtpRecorder) sourceFinished(completed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.observation.ActiveMediaWriters--
	if completed {
		r.sourcesCompleted++
	}
	r.observation.SourceDone = r.sourcesCompleted == r.source.tracks
}

func (r *rtpRecorder) mediaStopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.observation.ActiveMediaReaders == 0 && r.observation.ActiveMediaWriters == 0
}
