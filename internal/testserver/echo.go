// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"log"

	"github.com/pion/webrtc/v4"
)

func echo(pc *webrtc.PeerConnection) { pc.OnDataChannel(echoChannel) }

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
