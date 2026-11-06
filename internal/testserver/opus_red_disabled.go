// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

//go:build !pion_opus_red

package testserver

import (
	"errors"

	"github.com/pion/webrtc/v4"
)

func opusREDSupport() featureSupport {
	return featureSupport{Reason: "ConfigureOpusRED is unavailable in this test-server build"}
}

func newOpusREDPeer(
	_ webrtc.SettingEngine, _ webrtc.Configuration, _ *rtpRecorder,
	_ redPeerOptions,
) (*webrtc.PeerConnection, error) {
	return nil, errors.New(opusREDSupport().Reason)
}
