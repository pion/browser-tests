// SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
// SPDX-License-Identifier: MIT

package testserver

import (
	"maps"
	"reflect"

	"github.com/pion/webrtc/v4"
)

type featureSupport struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

// Optional fields are inspected at runtime so older WebRTC branches still build.
func boolOption(options any, name string) reflect.Value {
	value := reflect.Indirect(reflect.ValueOf(options))
	if !value.IsValid() || value.Kind() != reflect.Struct {
		return reflect.Value{}
	}
	field := value.FieldByName(name)
	if !field.IsValid() || field.Kind() != reflect.Bool || !field.CanSet() {
		return reflect.Value{}
	}

	return field
}

// buildFeatures lists features whose code is only compiled with a build tag, because it
// uses APIs that older dependencies lack. The tagged files mark them as supported.
var buildFeatures = map[string]featureSupport{ //nolint:gochecknoglobals
	"flexfecMultiFrame": {
		Reason: "Built without the flexfec_multiframe tag: this pion/interceptor has no flexfec.MultiFrame",
	},
}

func features() map[string]featureSupport {
	var options webrtc.OfferOptions
	supported := boolOption(&options, "DTLSRestart").IsValid()
	result := featureSupport{Supported: supported}
	if !supported {
		result.Reason = "This WebRTC build has no OfferOptions.DTLSRestart"
	}

	all := map[string]featureSupport{"dtlsRestart": result}
	maps.Copy(all, buildFeatures)

	return all
}
