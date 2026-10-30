// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"log"

	"github.com/pion/rtcp"
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
	return echoMedia(pc, nil)
}

// echoMedia sends every received track back to the peer. onRTCP, if set, sees the RTCP
// packets the peer sends about the echoed tracks.
func echoMedia(pc *webrtc.PeerConnection, onRTCP func([]rtcp.Packet)) error {
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
		go func() {
			for {
				packets, _, readErr := sender.ReadRTCP()
				if readErr != nil {
					return
				}
				if onRTCP != nil {
					onRTCP(packets)
				}
			}
		}()
	}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		local := tracks[remote.Kind()]
		for {
			packet, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			packet.Extension = false
			packet.Extensions = nil
			if err = local.WriteRTP(packet); err != nil {
				log.Printf("media echo %s: %v", remote.Kind(), err)

				return
			}
		}
	})

	return nil
}
