// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

// Package testserver exposes peer controls independently of test signaling.
package testserver

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type behavior struct {
	setup   func(*webrtc.PeerConnection) error
	channel func(*webrtc.DataChannel)
}

var behaviors = map[string]behavior{ //nolint:gochecknoglobals
	"none":              {},
	"datachannel-echo":  {setup: echo, channel: echoChannel},
	"media-echo":        {setup: mediaEcho},
	"red-audio-send":    {},
	"red-audio-receive": {},
	"red-bundled-echo":  {},
}

type peer struct {
	behavior     behavior
	pc           *webrtc.PeerConnection
	mu           sync.Mutex
	candidates   []webrtc.ICECandidateInit
	states       []string
	observations *rtpRecorder
	codecOrder   string
}

type Server struct {
	mu    sync.Mutex
	peers map[string]*peer
	next  atomic.Uint64
}

func New() *Server { return &Server{peers: make(map[string]*peer)} }

func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, session := range s.peers {
		delete(s.peers, id)
		_ = session.pc.Close()
	}
}

func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /features", func(res http.ResponseWriter, _ *http.Request) { reply(res, features()) })
	mux.HandleFunc("POST /peers", s.create)
	mux.HandleFunc("POST /peers/{id}/{operation}", s.operate)
	mux.HandleFunc("GET /peers/{id}", s.snapshot)
	mux.HandleFunc("GET /peers/{id}/stats", s.stats)
	mux.HandleFunc("GET /peers/{id}/rtp", s.rtp)
	mux.HandleFunc("DELETE /peers/{id}", s.remove)
}

func decode(res http.ResponseWriter, req *http.Request, target any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(res, req.Body, 1<<20)).Decode(target); err != nil {
		http.Error(res, err.Error(), http.StatusBadRequest)

		return false
	}

	return true
}

func reply(res http.ResponseWriter, value any) {
	res.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(res).Encode(value); err != nil {
		log.Printf("write peer response: %v", err)
	}
}

func (s *Server) create(res http.ResponseWriter, req *http.Request) {
	var body struct {
		CertificateCount int                   `json:"certificateCount"`
		Behavior         string                `json:"behavior"`
		Configuration    webrtc.Configuration  `json:"configuration"`
		OpusRED          bool                  `json:"opusRED"`
		StartWithRED     bool                  `json:"startWithRED"`
		REDPayloadTypes  *redPayloadTypes      `json:"opusREDPayloadTypes"`
		AudioCodecOrder  string                `json:"audioCodecOrder"`
		REDSource        *redSourceOptions     `json:"redSource"`
		REDImpairment    *redImpairmentOptions `json:"redImpairment"`
		ObservationLimit int                   `json:"observationLimit"`
		REDMaxPacketSize int                   `json:"redMaxPacketSize"`
	}
	if !decode(res, req, &body) {
		return
	}
	redOptions := redPeerOptions{PayloadTypes: body.REDPayloadTypes, CodecOrder: body.AudioCodecOrder,
		DisableFEC: body.REDSource != nil || body.REDImpairment != nil, MaxPacketSize: body.REDMaxPacketSize}
	if !body.OpusRED && (body.REDPayloadTypes != nil || body.AudioCodecOrder != "" ||
		body.REDSource != nil || body.REDImpairment != nil || body.ObservationLimit != 0 || body.REDMaxPacketSize != 0) {
		http.Error(res, "RED audio options require opusRED", http.StatusBadRequest)

		return
	}
	if (body.REDSource != nil || body.REDImpairment != nil) &&
		body.Behavior != "red-audio-send" && body.Behavior != "red-audio-receive" {
		http.Error(res, "controlled RED source requires an audio send/receive behavior", http.StatusBadRequest)

		return
	}
	if body.REDImpairment != nil && (((body.REDImpairment.InboundOrder != nil || len(body.REDImpairment.InboundPayloads) > 0) && body.Behavior != "red-audio-receive") ||
		(len(body.REDImpairment.OutboundDrop) > 0 && body.Behavior != "red-audio-send")) {
		http.Error(res, "RED loss and replay controls require their respective send/receive profile", http.StatusBadRequest)

		return
	}
	if body.OpusRED {
		if err := redOptions.validate(); err != nil {
			http.Error(res, err.Error(), http.StatusBadRequest)

			return
		}
	}
	if (body.Behavior == "red-audio-send" || body.Behavior == "red-audio-receive" || body.Behavior == "red-bundled-echo") && !body.OpusRED {
		http.Error(res, "RED audio behaviors require opusRED", http.StatusBadRequest)

		return
	}
	if body.REDSource != nil && body.REDSource.Tracks > 1 && body.Behavior != "red-audio-send" {
		http.Error(res, "multiple RED source tracks require red-audio-send", http.StatusBadRequest)

		return
	}
	if body.StartWithRED && (!body.OpusRED || body.Behavior != "red-audio-send") {
		http.Error(res, "startWithRED requires red-audio-send with opusRED", http.StatusBadRequest)

		return
	}
	if body.OpusRED && !opusREDSupport().Supported {
		http.Error(res, opusREDSupport().Reason, http.StatusNotImplemented)

		return
	}
	if body.Behavior == "" {
		body.Behavior = "none"
	}
	selected, ok := behaviors[body.Behavior]
	if !ok {
		http.Error(res, "unknown behavior: "+body.Behavior, http.StatusBadRequest)

		return
	}
	if body.CertificateCount < 0 || body.CertificateCount > 8 {
		http.Error(res, "certificateCount must be between 0 and 8", http.StatusBadRequest)

		return
	}
	fingerprints := make([]string, 0, body.CertificateCount)
	for range body.CertificateCount {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			http.Error(res, err.Error(), http.StatusInternalServerError)

			return
		}
		certificate, err := webrtc.GenerateCertificate(key)
		if err != nil {
			http.Error(res, err.Error(), http.StatusInternalServerError)

			return
		}
		values, err := certificate.GetFingerprints()
		if err != nil {
			http.Error(res, err.Error(), http.StatusInternalServerError)

			return
		}
		body.Configuration.Certificates = append(body.Configuration.Certificates, *certificate)
		fingerprints = append(fingerprints, values[0].Value)
	}
	loggerFactory := logging.NewDefaultLoggerFactory()
	loggerFactory.DefaultLogLevel = logging.LogLevelDebug
	settings := webrtc.SettingEngine{LoggerFactory: loggerFactory}
	var pc *webrtc.PeerConnection
	var err error
	var observation *rtpRecorder
	if body.OpusRED {
		observation, err = newRTPRecorder(body.StartWithRED, body.ObservationLimit, body.REDSource, body.REDImpairment)
		if err != nil {
			http.Error(res, err.Error(), http.StatusBadRequest)

			return
		}
		pc, err = newOpusREDPeer(settings, body.Configuration, observation, redOptions)
	} else {
		pc, err = webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(body.Configuration)
	}
	if err != nil {
		http.Error(res, err.Error(), http.StatusBadRequest)

		return
	}
	session := &peer{behavior: selected, pc: pc, observations: observation, codecOrder: body.AudioCodecOrder,
		candidates: []webrtc.ICECandidateInit{}, states: []string{}}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			session.mu.Lock()
			session.candidates = append(session.candidates, c.ToJSON())
			session.mu.Unlock()
		}
	})
	setup := selected.setup
	var mediaStateChange func(webrtc.PeerConnectionState)
	if observation != nil && body.Behavior == "media-echo" {
		setup = func(pc *webrtc.PeerConnection) error { return mediaEchoObserved(pc, observation) }
	}
	if body.Behavior == "red-bundled-echo" {
		setup = func(pc *webrtc.PeerConnection) error {
			if setupErr := mediaEchoObserved(pc, observation); setupErr != nil {
				return setupErr
			}

			return echo(pc)
		}
	}
	if body.Behavior == "red-audio-receive" {
		setup = func(pc *webrtc.PeerConnection) error { return redAudioReceive(pc, observation) }
	}
	if body.Behavior == "red-audio-send" {
		setup = func(pc *webrtc.PeerConnection) error {
			mediaStateChange, err = redAudioSend(pc, observation)

			return err
		}
	}
	if setup != nil {
		if err = setup(pc); err != nil {
			_ = pc.Close()
			http.Error(res, err.Error(), http.StatusBadRequest)

			return
		}
	}
	if body.OpusRED {
		if err = setREDAudioPreferences(pc, body.AudioCodecOrder); err != nil {
			_ = pc.Close()
			http.Error(res, err.Error(), http.StatusBadRequest)

			return
		}
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		session.mu.Lock()
		session.states = append(session.states, state.String())
		session.mu.Unlock()
		if mediaStateChange != nil {
			mediaStateChange(state)
		}
	})
	id := strconv.FormatUint(s.next.Add(1), 10)
	s.mu.Lock()
	s.peers[id] = session
	s.mu.Unlock()
	response := map[string]any{"id": id}
	if len(fingerprints) > 0 {
		response["certificateFingerprints"] = fingerprints
	}
	reply(res, response)
}

func (s *Server) lookup(res http.ResponseWriter, req *http.Request) *peer {
	s.mu.Lock()
	value, ok := s.peers[req.PathValue("id")]
	s.mu.Unlock()
	if !ok {
		http.Error(res, "unknown peer", http.StatusNotFound)

		return nil
	}

	return value
}

func (s *Server) remove(res http.ResponseWriter, req *http.Request) {
	s.mu.Lock()
	value := s.peers[req.PathValue("id")]
	delete(s.peers, req.PathValue("id"))
	s.mu.Unlock()
	if value != nil {
		_ = value.pc.Close()
	}
	res.WriteHeader(http.StatusNoContent)
}

func (s *Server) snapshot(res http.ResponseWriter, req *http.Request) {
	session := s.lookup(res, req)
	if session == nil {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	reply(res, map[string]any{
		"localDescription": session.pc.LocalDescription(), "remoteDescription": session.pc.RemoteDescription(),
		"iceGatheringState": session.pc.ICEGatheringState().String(),
		"connectionState":   session.pc.ConnectionState().String(), "signalingState": session.pc.SignalingState().String(),
		"candidates": session.candidates, "states": session.states,
	})
}

func (s *Server) stats(res http.ResponseWriter, req *http.Request) {
	session := s.lookup(res, req)
	if session == nil {
		return
	}
	reply(res, session.pc.GetStats())
}

func (s *Server) rtp(res http.ResponseWriter, req *http.Request) {
	session := s.lookup(res, req)
	if session == nil {
		return
	}
	if session.observations == nil {
		http.Error(res, "RTP observations require an opusRED peer", http.StatusBadRequest)

		return
	}
	reply(res, session.observations.snapshot())
}

func (s *Server) operate(res http.ResponseWriter, req *http.Request) {
	session := s.lookup(res, req)
	if session == nil {
		return
	}
	var result any = map[string]any{}
	var err error
	switch req.PathValue("operation") {
	case "replace-red-audio":
		if session.observations == nil {
			http.Error(res, "audio replacement requires a RED sender", http.StatusBadRequest)

			return
		}
		var options struct {
			Index int `json:"index"`
		}
		if !decode(res, req, &options) {
			return
		}
		err = session.observations.replaceAudioTrack(options.Index)
	case "close-red-media":
		if session.observations == nil {
			http.Error(res, "media drain observations require a RED peer", http.StatusBadRequest)

			return
		}
		err = session.pc.Close()
		if err == nil {
			deadline := time.Now().Add(5 * time.Second)
			for !session.observations.mediaStopped() {
				if time.Now().After(deadline) {
					err = fmt.Errorf("RED media readers or writers did not stop after close")

					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		result = session.observations.snapshot()
	case "create-offer":
		var options struct {
			webrtc.OfferOptions
			DTLSRestart bool `json:"dtlsRestart"`
		}
		if !decode(res, req, &options) {
			return
		}
		if options.DTLSRestart {
			field := boolOption(&options.OfferOptions, "DTLSRestart")
			if !field.IsValid() {
				http.Error(res, features()["dtlsRestart"].Reason, http.StatusNotImplemented)

				return
			}
			field.SetBool(true)
		}
		result, err = session.pc.CreateOffer(&options.OfferOptions)
	case "create-answer":
		result, err = session.pc.CreateAnswer(nil)
	case "set-local-description", "set-remote-description":
		var description webrtc.SessionDescription
		if !decode(res, req, &description) {
			return
		}
		if req.PathValue("operation") == "set-local-description" {
			err = session.pc.SetLocalDescription(description)
		} else {
			err = session.pc.SetRemoteDescription(description)
			if err == nil && description.Type == webrtc.SDPTypeOffer && session.observations != nil {
				err = setREDAudioPreferences(session.pc, session.codecOrder)
			}
		}
	case "add-ice-candidate":
		var candidate webrtc.ICECandidateInit
		if !decode(res, req, &candidate) {
			return
		}
		err = session.pc.AddICECandidate(candidate)
	case "create-data-channel":
		var body struct {
			Label   string                 `json:"label"`
			Options webrtc.DataChannelInit `json:"options"`
		}
		if !decode(res, req, &body) {
			return
		}
		var dc *webrtc.DataChannel
		dc, err = session.pc.CreateDataChannel(body.Label, &body.Options)
		if err == nil && session.behavior.channel != nil {
			session.behavior.channel(dc)
		}
	default:
		http.Error(res, "unknown operation", http.StatusNotFound)

		return
	}
	if err != nil {
		http.Error(res, fmt.Sprintf("%s: %v", req.PathValue("operation"), err), http.StatusBadRequest)

		return
	}
	reply(res, result)
}
