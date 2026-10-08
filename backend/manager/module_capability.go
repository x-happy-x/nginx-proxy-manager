package main

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"os"
	"path/filepath"
	"runtime"
)

// Legacy manager has all adapters. A worker discovers optional providers through
// the committed registry, never through configuration-file existence.
func moduleEnabled(id string) bool {
	state := os.Getenv("HOMENET_PLATFORM_STATE")
	if state == "" {
		return true
	}
	registry, err := integration.Open(filepath.Join(state, "registry.json"), runtime.GOARCH)
	if err != nil {
		return false
	}
	for _, item := range registry.Snapshot() {
		if item.Manifest.ID == id {
			return item.Enabled
		}
	}
	return false
}
