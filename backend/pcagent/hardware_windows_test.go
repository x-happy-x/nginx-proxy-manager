package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestHardwareProvidersFailIndependently(t *testing.T) {
	h := platformHardware(context.Background(), func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name != "powershell.exe" {
			t.Errorf("unexpected process %s", name)
		}
		script := args[len(args)-1]
		if strings.HasPrefix(script, "$section='sensors'") {
			return nil, errors.New("access denied")
		}
		if strings.HasPrefix(script, "$section='system'") {
			return []byte(`{"cpu":{"model":"test CPU","cores":16},"memory":{"installed":103079215104},"issues":[]}`), nil
		}
		if strings.HasPrefix(script, "$section='devices'") {
			return []byte(`{"devices":[{"id":"pci:test","status":"unrecognized","future_field":{"value":1}}],"issues":["partial test"]}`), nil
		}
		return []byte(`{"disks":[{"id":"disk:3","volumes":["C:","D:"]}],"issues":[]}`), nil
	})
	if h["cpu"] == nil || h["memory"] == nil || h["disks"] == nil || h["devices"] == nil {
		t.Fatalf("lost independent providers: %#v", h)
	}
	sources := h["sources"].(map[string]any)
	if sources["sensors"].(map[string]any)["status"] != "unavailable" || sources["devices"].(map[string]any)["status"] != "partial" {
		t.Fatal(sources)
	}
	device := h["devices"].([]any)[0].(map[string]any)
	if device["future_field"] == nil {
		t.Fatal("unknown source fields discarded")
	}
}
