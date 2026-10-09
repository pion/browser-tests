// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"errors"
	"strings"

	"github.com/pion/webrtc/v4"
)

type redPayloadTypes struct {
	Opus uint8 `json:"opus"`
	RED  uint8 `json:"red"`
}

type redPeerOptions struct {
	PayloadTypes  *redPayloadTypes
	CodecOrder    string
	DisableFEC    bool
	MaxPacketSize int
}

func (o redPeerOptions) payloadTypes() redPayloadTypes {
	if o.PayloadTypes != nil {
		return *o.PayloadTypes
	}

	return redPayloadTypes{Opus: 111, RED: 63}
}

func (o redPeerOptions) validate() error {
	if o.MaxPacketSize < 0 || o.MaxPacketSize > 65535 {
		return errors.New("RED packet size budget must be between 1 and 65535")
	}
	pt := o.payloadTypes()
	if pt.Opus == 0 || pt.RED == 0 || pt.Opus > 127 || pt.RED > 127 || pt.Opus == pt.RED {
		return errors.New("RED requires distinct payload types between 1 and 127")
	}
	switch o.CodecOrder {
	case "", "red-first", "opus-first", "opus-only":
		return nil
	default:
		return errors.New("unknown RED audio codec order")
	}
}

// Reuse registered codec records, preserving payload mappings and fmtp.
func setREDAudioPreferences(pc *webrtc.PeerConnection, order string) error {
	if order == "" {
		return nil
	}
	for _, transceiver := range pc.GetTransceivers() {
		if transceiver.Kind() != webrtc.RTPCodecTypeAudio {
			continue
		}
		// Obtain current negotiated records when answering a remotely remapped
		// offer, rather than retaining payload numbers from an earlier offer.
		if err := transceiver.SetCodecPreferences(nil); err != nil {
			return err
		}
		var codecs []webrtc.RTPCodecParameters
		if receiver := transceiver.Receiver(); receiver != nil {
			codecs = receiver.GetParameters().Codecs
		} else if sender := transceiver.Sender(); sender != nil {
			codecs = sender.GetParameters().Codecs
		}
		var opus, red []webrtc.RTPCodecParameters
		for _, codec := range codecs {
			switch {
			case strings.EqualFold(codec.MimeType, webrtc.MimeTypeOpus):
				opus = append(opus, codec)
			case strings.EqualFold(codec.MimeType, "audio/red"):
				red = append(red, codec)
			}
		}
		preferences := opus
		if order == "red-first" {
			preferences = append(red, opus...)
		} else if order == "opus-first" {
			preferences = append(opus, red...)
		}
		if err := transceiver.SetCodecPreferences(preferences); err != nil {
			return err
		}
	}

	return nil
}
