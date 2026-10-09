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

func TestREDMediaLifecycleBeforeConnection(t *testing.T) {
	if !opusREDSupport().Supported {
		t.Skip("selected Pion has no RED configuration API")
	}
	server := New()
	defer server.Close()
	mux := http.NewServeMux()
	server.Register(mux)
	call := func(path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		require.Equal(t, status, response.Code, response.Body.String())

		return response
	}
	response := call("/peers", `{"opusRED":true,"behavior":"red-audio-send","redSource":{"tracks":2}}`, http.StatusOK)
	var created struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &created))
	path := "/peers/" + created.ID
	offer := call(path+"/create-offer", `{}`, http.StatusOK)
	require.Equal(t, 2, strings.Count(offer.Body.String(), "m=audio "))
	call(path+"/replace-red-audio", `{"index":1}`, http.StatusOK)
	call(path+"/replace-red-audio", `{"index":2}`, http.StatusBadRequest)
	response = call(path+"/close-red-media", `{}`, http.StatusOK)
	var observations rtpSnapshot
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &observations))
	require.Zero(t, observations.ActiveMediaReaders, "unconnected RTCP readers must stop")
	require.Zero(t, observations.ActiveMediaWriters, "sources waiting for connection must stop")
	require.False(t, observations.SourceDone, "cancelled sources have not completed playback")
	require.Empty(t, observations.Source)
	require.Empty(t, observations.Errors)
	call(path+"/close-red-media", `{}`, http.StatusOK)
}
