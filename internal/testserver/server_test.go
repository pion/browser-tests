// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPeerIsolationAndLifecycle(t *testing.T) {
	server := New()
	defer server.Close()
	mux := http.NewServeMux()
	server.Register(mux)
	call := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))
		require.Equal(t, status, response.Code, "%s %s: %s", method, path, response.Body)

		return response
	}
	create := func() string {
		t.Helper()
		response := call("POST", "/peers", `{"behavior":"datachannel-echo"}`, 200)
		var result struct {
			ID string `json:"id"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))

		return "/peers/" + result.ID
	}
	call("POST", "/peers", `{"behavior":"missing"}`, 400)
	call("POST", "/peers", `{`, 400)
	first, second := create(), create()
	require.NotEqual(t, first, second, "peer IDs reused")
	call("POST", first+"/set-remote-description", `{"type":"offer","sdp":"invalid"}`, 400)
	call("POST", second+"/create-data-channel", `{"label":"second"}`, 200)
	offer := call("POST", second+"/create-offer", `{}`, 200)
	require.Contains(t, offer.Body.String(), "m=application")
	stats := call("GET", second+"/stats", "", 200)
	require.Contains(t, stats.Body.String(), `"type":"data-channel"`)
	call("DELETE", first, "", 204)
	call("DELETE", first, "", 204)
	call("GET", first, "", 404)
	call("GET", first+"/stats", "", 404)
	call("GET", second, "", 200)
	call("POST", second+"/unknown", `{}`, 404)
	server.Close()
	call("GET", second, "", 404)
}
