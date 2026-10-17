// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

//go:build pion_opus_red

package testserver

import (
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

func opusREDSupport() featureSupport { return featureSupport{Supported: true} }

func newOpusREDPeer(
	settings webrtc.SettingEngine, configuration webrtc.Configuration, observation *rtpRecorder,
	options redPeerOptions,
) (*webrtc.PeerConnection, error) {
	media := &webrtc.MediaEngine{}
	pt := options.payloadTypes()
	if options.PayloadTypes == nil || pt == (redPayloadTypes{Opus: 111, RED: 63}) {
		if err := media.RegisterDefaultCodecs(); err != nil {
			return nil, err
		}
	} else {
		// Alternate mappings are audio-only; a second canonical Opus codec
		// would allow negotiation to bypass the mapping being tested.
		if err := media.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
				SDPFmtpLine: "minptime=10;useinbandfec=1",
			}, PayloadType: webrtc.PayloadType(pt.Opus),
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(media, registry); err != nil {
		return nil, err
	}
	// Observe RED on the wire side of the encoder/decoder, alongside reports and stats.
	registry.Add(observation)
	if err := webrtc.ConfigureOpusRED(webrtc.PayloadType(pt.Opus), webrtc.PayloadType(pt.RED), media, registry); err != nil {
		return nil, err
	}

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settings),
		webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(registry),
	).NewPeerConnection(configuration)
}
