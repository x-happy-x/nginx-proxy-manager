package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestProxmoxLive reads the real host; run on the router with PVE_LIVE=1.
func TestProxmoxLive(t *testing.T) {
	if os.Getenv("PVE_LIVE") != "1" {
		t.Skip("set PVE_LIVE=1 on the router")
	}
	c := newPVEClient(os.Getenv("PROXMOX_URL"), os.Getenv("PROXMOX_TOKEN_FILE"), os.Getenv("PROXMOX_FINGERPRINT"))
	state := c.poll()
	body, _ := json.Marshal(state)
	t.Log(string(body))
	bad := newPVEClient(os.Getenv("PROXMOX_URL"), os.Getenv("PROXMOX_TOKEN_FILE"), "00:11")
	if bad.poll().Error == "" {
		t.Fatal("wrong fingerprint was accepted")
	}
	mesh, err := readMesh("http://127.0.0.1:79/rci")
	body, _ = json.Marshal(mesh)
	t.Log(string(body), err)
}
