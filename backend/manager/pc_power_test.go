package main

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPCMagicPacketAndPowerPermissions(t *testing.T) {
	p, err := pcMagicPacket("AC:82:47:4B:EB:D7")
	if err != nil || len(p) != 102 || !bytes.Equal(p[:6], bytes.Repeat([]byte{255}, 6)) {
		t.Fatalf("packet %x %v", p, err)
	}
	for i := 6; i < len(p); i += 6 {
		if !bytes.Equal(p[i:i+6], []byte{0xac, 0x82, 0x47, 0x4b, 0xeb, 0xd7}) {
			t.Fatal("wrong target")
		}
	}
	for _, bad := range []string{"", "00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01:02:03:04:05:06", "ac:82:47:4b:eb:d7;reboot"} {
		if _, err := pcMagicPacket(bad); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	m := pcTestMonitor(t)
	h := m.hosts[0]
	a := pcAction{Host: h.Config.ID, Target: "power", Action: "shutdown", Confirm: h.Config.Name}
	if _, _, _, err := m.validateActionLocked(a); err == nil {
		t.Fatal("disabled host accepted shutdown")
	}
	h.Config.PowerEnabled = true
	h.Config.MAC = "ac:82:47:4b:eb:d7"
	if _, _, _, err := m.validateActionLocked(a); err == nil {
		t.Fatal("old agent accepted shutdown")
	}
	h.Current.Capabilities.PowerActions = []string{"shutdown"}
	if _, _, _, err := m.validateActionLocked(a); err != nil {
		t.Fatal(err)
	}
	a.Confirm = "wrong"
	if _, _, _, err := m.validateActionLocked(a); err == nil {
		t.Fatal("shutdown without confirmation")
	}
	a.Confirm = h.Config.Name
	h.Online = false
	if _, _, _, err := m.validateActionLocked(a); err == nil {
		t.Fatal("offline shutdown accepted")
	}
	a.Action = "start"
	if _, _, _, err := m.validateActionLocked(a); err != nil {
		t.Fatal("offline wake denied", err)
	}
	h.Checked = time.Now()
	h.Error = "Permission denied"
	if m.powerInfoLocked(h)["state"] != "unavailable" {
		t.Fatal("agent authentication failure reported off")
	}
	h.Error = "Connection refused"
	if m.powerInfoLocked(h)["state"] != "off" {
		t.Fatal("unreachable computer not off")
	}
	h.Checked = time.Now().Add(-3 * time.Minute)
	if m.powerInfoLocked(h)["state"] != "unavailable" {
		t.Fatal("stale observation reported off")
	}
}

func TestPCPowerTokenIsScopedAndFailClosed(t *testing.T) {
	m := pcTestMonitor(t)
	previous := pcm
	pcm = m
	t.Cleanup(func() { pcm = previous })
	token := strings.Repeat("t", 48)
	if err := os.WriteFile(filepath.Join(m.dir, "power-token"), []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(method, auth, origin, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/integrations/pc-power", strings.NewReader(body))
		r.Header.Set("Authorization", auth)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		(&app{}).handle(w, r)
		return w
	}
	for _, auth := range []string{"", token, "Bearer wrong"} {
		if w := call("GET", auth, "", ""); w.Code != 401 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if w := call("GET", "Bearer "+token, "https://evil.test", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := call("GET", "Bearer "+token, "", ""); w.Code != 200 || strings.Contains(w.Body.String(), "Office") || strings.Contains(w.Body.String(), token) {
		t.Fatal(w.Code, w.Body)
	}
	if w := call("POST", "Bearer "+token, "", `{"host":"office","on":false}`); w.Code != 403 {
		t.Fatal(w.Code, w.Body)
	}
	for _, body := range []string{`{"host":"office"}`, `{"host":"office","on":false,"command":"reboot"}`} {
		if w := call("POST", "Bearer "+token, "", body); w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
}
