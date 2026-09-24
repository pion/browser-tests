// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

// Package testserver exposes peer controls independently of test signaling.
package testserver

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

type behavior struct {
	setup   func(*webrtc.PeerConnection)
	channel func(*webrtc.DataChannel)
}

var behaviors = map[string]behavior{ //nolint:gochecknoglobals
	"none":             {},
	"datachannel-echo": {setup: echo, channel: echoChannel},
}

type peer struct {
	behavior   behavior
	pc         *webrtc.PeerConnection
	mu         sync.Mutex
	candidates []webrtc.ICECandidateInit
	states     []string
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
	mux.HandleFunc("POST /peers", s.create)
	mux.HandleFunc("POST /peers/{id}/{operation}", s.operate)
	mux.HandleFunc("GET /peers/{id}", s.snapshot)
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
		Behavior      string               `json:"behavior"`
		Configuration webrtc.Configuration `json:"configuration"`
	}
	if !decode(res, req, &body) {
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
	pc, err := webrtc.NewPeerConnection(body.Configuration)
	if err != nil {
		http.Error(res, err.Error(), http.StatusBadRequest)

		return
	}
	session := &peer{behavior: selected, pc: pc, candidates: []webrtc.ICECandidateInit{}, states: []string{}}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			session.mu.Lock()
			session.candidates = append(session.candidates, c.ToJSON())
			session.mu.Unlock()
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		session.mu.Lock()
		session.states = append(session.states, state.String())
		session.mu.Unlock()
	})
	if selected.setup != nil {
		selected.setup(pc)
	}
	id := strconv.FormatUint(s.next.Add(1), 10)
	s.mu.Lock()
	s.peers[id] = session
	s.mu.Unlock()
	reply(res, map[string]string{"id": id})
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

func (s *Server) operate(res http.ResponseWriter, req *http.Request) {
	session := s.lookup(res, req)
	if session == nil {
		return
	}
	var result any = map[string]any{}
	var err error
	switch req.PathValue("operation") {
	case "create-offer":
		var options webrtc.OfferOptions
		if !decode(res, req, &options) {
			return
		}
		result, err = session.pc.CreateOffer(&options)
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
