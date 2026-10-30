// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

//go:build flexfec_multiframe

package testserver

import (
	"log"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/flexfec"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	flexfecPayloadType = 49
	// Every flexfecLossInterval-th packet of a FEC-protected stream is dropped.
	flexfecLossInterval = 10
	// Protection groups span up to this many frames.
	flexfecMaxFrames = 3
)

func init() { //nolint:gochecknoinits
	buildFeatures["flexfecMultiFrame"] = featureSupport{Supported: true}
	behaviors["flexfec-echo"] = behavior{api: flexfecAPI, setup: flexfecEcho}
}

// flexfecAPI sends FlexFEC with multi-frame protection groups over a lossy link. NACK is not
// negotiated, so lost packets can only be recovered from FEC.
func flexfecAPI(settings webrtc.SettingEngine) (*webrtc.API, error) {
	mediaEngine := &webrtc.MediaEngine{}
	for _, codec := range []struct {
		kind   webrtc.RTPCodecType
		params webrtc.RTPCodecParameters
	}{
		{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			PayloadType:        111,
		}},
		{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
				// Keyframe requests only: losses FEC cannot repair end in a visible PLI.
				RTCPFeedback: []webrtc.RTCPFeedback{{Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"}},
			},
			PayloadType: 96,
		}},
	} {
		if err := mediaEngine.RegisterCodec(codec.params, codec.kind); err != nil {
			return nil, err
		}
	}

	registry := &interceptor.Registry{}
	// Added first so it sits closest to the network and drops packets after FEC is generated.
	registry.Add(&lossInterceptorFactory{})
	// Groups are fixed at flexfecMaxFrames frames: on loopback the measured RTT would
	// otherwise shrink them to a single frame.
	if err := webrtc.ConfigureFlexFEC03(flexfecPayloadType, mediaEngine, registry,
		flexfec.MultiFrame(flexfecMaxFrames),
		flexfec.ProtectionLevel(0.25),
		flexfec.MaxExcessOverhead(0),
		flexfec.DisableRTTAdaptation(),
	); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, err
	}

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settings),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	), nil
}

// flexfecEcho echoes media and forwards keyframe requests for the echoed video back to the
// browser, which owns the encoder.
func flexfecEcho(pc *webrtc.PeerConnection) error {
	return echoMedia(pc, func(packets []rtcp.Packet) {
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			default:
				continue
			}
			for _, receiver := range pc.GetReceivers() {
				track := receiver.Track()
				if track == nil || track.Kind() != webrtc.RTPCodecTypeVideo {
					continue
				}
				pli := &rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}
				if err := pc.WriteRTCP([]rtcp.Packet{pli}); err != nil {
					log.Printf("flexfec echo: forward keyframe request: %v", err)
				}
			}
		}
	})
}

// lossInterceptorFactory drops every flexfecLossInterval-th media packet of streams that
// carry FEC, and never the FEC packets themselves.
type lossInterceptorFactory struct{}

func (*lossInterceptorFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &lossInterceptor{}, nil
}

type lossInterceptor struct {
	interceptor.NoOp
}

func (*lossInterceptor) BindLocalStream(
	info *interceptor.StreamInfo, writer interceptor.RTPWriter,
) interceptor.RTPWriter {
	if info.SSRCForwardErrorCorrection == 0 {
		return writer
	}
	var (
		mu    sync.Mutex
		count int
	)

	return interceptor.RTPWriterFunc(func(
		header *rtp.Header, payload []byte, attributes interceptor.Attributes,
	) (int, error) {
		if header.SSRC == info.SSRC {
			mu.Lock()
			count++
			drop := count%flexfecLossInterval == 0
			mu.Unlock()
			if drop {
				return header.MarshalSize() + len(payload), nil
			}
		}

		return writer.Write(header, payload, attributes)
	})
}
