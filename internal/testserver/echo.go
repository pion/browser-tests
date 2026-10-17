// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"log"

	"github.com/pion/webrtc/v4"
)

func echo(pc *webrtc.PeerConnection) error {
	pc.OnDataChannel(echoChannel)

	return nil
}

func echoChannel(dc *webrtc.DataChannel) {
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		var err error
		if message.IsString {
			err = dc.SendText(string(message.Data))
		} else {
			err = dc.Send(message.Data)
		}
		if err != nil {
			log.Printf("echo channel %q (%s): %v", dc.Label(), dc.ReadyState(), err)
		}
	})
}

func mediaEcho(pc *webrtc.PeerConnection) error {
	return mediaEchoObserved(pc, nil)
}

func mediaEchoObserved(pc *webrtc.PeerConnection, observation *rtpRecorder) error {
	tracks := make(map[webrtc.RTPCodecType]*webrtc.TrackLocalStaticRTP)
	for _, codec := range []webrtc.RTPCodecCapability{
		{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
	} {
		track, err := webrtc.NewTrackLocalStaticRTP(codec, codec.MimeType, "echo")
		if err != nil {
			return err
		}
		sender, err := pc.AddTrack(track)
		if err != nil {
			return err
		}
		tracks[track.Kind()] = track
		readerDone := func() {}
		if observation != nil {
			readerDone = observation.mediaReader()
		}
		go func() {
			defer readerDone()
			for {
				if _, _, readErr := sender.ReadRTCP(); readErr != nil {
					return
				}
			}
		}()
	}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if observation != nil {
			defer observation.mediaReader()()
		}
		local := tracks[remote.Kind()]
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				if observation != nil {
					observation.recordError(err)
				}
				return
			}
			if observation != nil && remote.Kind() == webrtc.RTPCodecTypeAudio {
				observation.record(&observation.observation.Application, &packet.Header, packet.Payload)
			}
			packet.Extension = false
			packet.Extensions = nil
			if err = local.WriteRTP(packet); err != nil {
				if observation != nil {
					observation.recordError(err)
				}
				log.Printf("media echo %s: %v", remote.Kind(), err)

				return
			}
		}
	})

	return nil
}
