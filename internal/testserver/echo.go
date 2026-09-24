// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import "github.com/pion/webrtc/v4"

func echo(pc *webrtc.PeerConnection) { pc.OnDataChannel(echoChannel) }

func echoChannel(dc *webrtc.DataChannel) {
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString {
			_ = dc.SendText(string(message.Data))
		} else {
			_ = dc.Send(message.Data)
		}
	})
}
