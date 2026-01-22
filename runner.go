// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

type offerRequest struct {
	SDP      string `json:"sdp"`
	Type     string `json:"type"`
	Scenario string `json:"scenario"`
}

type answerResponse struct {
	SDP  string `json:"sdp"`
	Type string `json:"type"`
}

var (
	peerID      uint64   //nolint:gochecknoglobals
	activePeers sync.Map //nolint:gochecknoglobals
)

func main() {
	addr := getenv("TESTSERVER_ADDR", "127.0.0.1:38481")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/offer", offerHandler)

	server := &http.Server{
		Addr:              addr,
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	listener, err := net.Listen("tcp", addr) //nolint:noctx
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("pion testserver listening on http://%s", listener.Addr().String())
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)

		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func offerHandler(res http.ResponseWriter, re *http.Request) {
	if re.Method == http.MethodOptions {
		res.WriteHeader(http.StatusNoContent)

		return
	}

	if re.Method != http.MethodPost {
		http.Error(res, "method not allowed", http.StatusMethodNotAllowed)

		return
	}

	var req offerRequest
	if err := json.NewDecoder(http.MaxBytesReader(res, re.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(res, "invalid json", http.StatusBadRequest)

		return
	}

	if req.SDP == "" {
		http.Error(res, "missing sdp", http.StatusBadRequest)

		return
	}

	scenario := req.Scenario
	if scenario == "" {
		scenario = "hello"
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(res, "failed to create peer connection", http.StatusInternalServerError)

		return
	}

	id := atomic.AddUint64(&peerID, 1)
	activePeers.Store(id, pc)

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateFailed,
			webrtc.PeerConnectionStateDisconnected:
			_ = pc.Close()
			activePeers.Delete(id)
		default:
		}
	})

	switch scenario {
	case "hello":
		scenarioHello(pc)
	default:
		http.Error(res, fmt.Sprintf("unknown scenario: %s", scenario), http.StatusBadRequest)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}

	offerType := req.Type
	if offerType == "" {
		offerType = "offer"
	}
	if offerType != "offer" {
		http.Error(res, "only offer type supported", http.StatusBadRequest)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}

	if err = pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  req.SDP,
	}); err != nil {
		http.Error(res, "failed to set remote description", http.StatusBadRequest)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(res, "failed to create answer", http.StatusInternalServerError)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		http.Error(res, "failed to set local description", http.StatusInternalServerError)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}
	<-gatherComplete

	local := pc.LocalDescription()
	if local == nil {
		http.Error(res, "local description missing", http.StatusInternalServerError)
		_ = pc.Close()
		activePeers.Delete(id)

		return
	}

	response := answerResponse{
		SDP:  local.SDP,
		Type: local.Type.String(),
	}
	res.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(res).Encode(response); err != nil {
		_ = pc.Close()
		activePeers.Delete(id)
	}
}

func scenarioHello(pc *webrtc.PeerConnection) {
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				_ = dc.SendText(string(msg.Data))

				return
			}
			_ = dc.Send(msg.Data)
		})
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		next.ServeHTTP(w, r)
	})
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	return value
}
