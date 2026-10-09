// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"strconv"

	"github.com/pion/rtp"
)

type rtpSummary struct {
	Count              uint64 `json:"count"`
	SHA256             string `json:"sha256"`
	LastSequenceNumber uint16 `json:"lastSequenceNumber"`
	LastTimestamp      uint32 `json:"lastTimestamp"`
}

type rtpDigest struct {
	summary rtpSummary
	digest  hash.Hash
}

type rtpStatistics struct {
	totals      map[string]uint64
	source      map[uint32]*rtpDigest
	application map[uint32]*rtpDigest
}

type rtpSummaries struct {
	Source      map[string]rtpSummary `json:"source"`
	Application map[string]rtpSummary `json:"application"`
}

func (r *rtpRecorder) recordWire(target *[]observedRTP, header *rtp.Header, payload []byte, redPayloadType uint8) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recordLocked(target, header, payload)
	if redPayloadType == 0 || header.PayloadType != redPayloadType || len(payload) == 0 {
		return
	}
	if target == &r.observation.Inbound {
		r.statistics.totals["inboundRED"]++
	} else if target == &r.observation.Outbound {
		r.statistics.totals["outboundRED"]++
	}
}

// Counts and rolling digests continue after the bounded observation prefix.
// Hash length-delimited normalized Opus identities and payloads in delivery order.
func (r *rtpRecorder) recordStatisticsLocked(target *[]observedRTP, header *rtp.Header, payload []byte) {
	kind := ""
	switch target {
	case &r.observation.Source:
		kind = "source"
	case &r.observation.Application:
		kind = "application"
	case &r.observation.Inbound:
		kind = "inbound"
	case &r.observation.InboundOriginal:
		kind = "inboundOriginal"
	case &r.observation.Outbound:
		kind = "outbound"
	case &r.observation.DroppedOutbound:
		kind = "droppedOutbound"
	}
	if kind == "" {
		if len(r.observation.Errors) < 8 {
			r.observation.Errors = append(r.observation.Errors, "unknown RED statistics target")
		}
		return
	}
	if r.statistics.totals == nil {
		r.statistics.totals = make(map[string]uint64)
	}
	r.statistics.totals[kind]++
	if !r.source.stream || len(payload) == 0 || (kind != "source" && kind != "application") {
		return
	}
	summaries := &r.statistics.source
	if kind == "application" {
		summaries = &r.statistics.application
	}
	if *summaries == nil {
		*summaries = make(map[uint32]*rtpDigest)
	}
	entry := (*summaries)[header.SSRC]
	if entry == nil {
		if len(*summaries) >= 16 {
			if len(r.observation.Errors) < 8 {
				r.observation.Errors = append(r.observation.Errors, "RED observation exceeded 16 summary SSRCs")
			}
			return
		}
		entry = &rtpDigest{digest: sha256.New()}
		(*summaries)[header.SSRC] = entry
	}
	var normalized [15]byte
	binary.BigEndian.PutUint32(normalized[0:4], header.SSRC)
	binary.BigEndian.PutUint16(normalized[4:6], header.SequenceNumber)
	binary.BigEndian.PutUint32(normalized[6:10], header.Timestamp)
	normalized[10] = header.PayloadType
	binary.BigEndian.PutUint32(normalized[11:15], uint32(len(payload))) //nolint:gosec // Payloads are bounded RTP packets.
	_, _ = entry.digest.Write(normalized[:])
	_, _ = entry.digest.Write(payload)
	entry.summary.Count++
	entry.summary.LastSequenceNumber, entry.summary.LastTimestamp = header.SequenceNumber, header.Timestamp
}

func (s *rtpStatistics) snapshot() (map[string]uint64, rtpSummaries) {
	totals := map[string]uint64{"source": 0, "application": 0, "inbound": 0, "inboundOriginal": 0, "outbound": 0, "droppedOutbound": 0, "inboundRED": 0, "outboundRED": 0}
	for key, value := range s.totals {
		totals[key] = value
	}
	summarize := func(entries map[uint32]*rtpDigest) map[string]rtpSummary {
		result := make(map[string]rtpSummary, len(entries))
		for ssrc, entry := range entries {
			summary := entry.summary
			summary.SHA256 = fmt.Sprintf("%x", entry.digest.Sum(nil))
			result[strconv.FormatUint(uint64(ssrc), 10)] = summary
		}
		return result
	}
	return totals, rtpSummaries{Source: summarize(s.source), Application: summarize(s.application)}
}
