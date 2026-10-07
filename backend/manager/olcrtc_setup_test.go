package main

import (
	"strings"
	"testing"
	"time"
)

func TestOlcShellQuoting(t *testing.T) {
	if got := shq(`a'b; rm -rf /`); got != `'a'\''b; rm -rf /'` {
		t.Fatalf("shq = %s", got)
	}
}

func TestOlcSignerIsKeptAndPublicKeyIsAuthorizedKeysLine(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	a, b := olcPublicKey(), olcPublicKey()
	if a == "" || a != b {
		t.Fatalf("public key not stable: %q vs %q", a, b)
	}
	if !strings.HasPrefix(a, "ssh-ed25519 ") || !strings.HasSuffix(a, " homenet@router") {
		t.Fatalf("public key = %q", a)
	}
}

func TestOlcSetupRejectsBadInput(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	o := &olcState{path: olcStatePath(), st: olcStore{Checks: map[string]olcCheck{}}}
	for _, req := range []olcSetupReq{
		{Host: "1.2.3.4; reboot", User: "root"},
		{Host: "1.2.3.4", User: "root; id"},
		{Host: "1.2.3.4", User: "root", Port: 70000},
	} {
		if _, err := o.start("setup", req); err == nil {
			t.Fatalf("accepted %+v", req)
		}
	}
	if len(o.st.Servers) != 0 {
		t.Fatal("a rejected request left a server behind")
	}
	if _, err := o.start("repick", olcSetupReq{ID: "nope"}); err == nil {
		t.Fatal("repick of an unknown server accepted")
	}
}

func TestParseOlcExistingFindsSrvShContainers(t *testing.T) {
	key := strings.Repeat("ab", 32)
	out := "HOMENET:\nF /opt/olcrtc/olcrtc\nU olcrtc@v1-datachannel.service active\nPODMAN:\nC olcrtc-server-x running /tmp/olcrtc-deploy-x\n  mode: srv\n  auth:\n    provider: \"jitsi\"\n  room:\n    id: \"https://meet.example.ru/room-1\"\n  crypto:\n    key: \"" + key + "\"\n  net:\n    transport: \"datachannel\"\nEND"
	found, own := parseOlcExisting(out)
	if len(found) != 1 || found[0].Room != "https://meet.example.ru/room-1" || found[0].Transport != "datachannel" || !found[0].InTmp || found[0].key != key {
		t.Fatalf("found = %+v", found)
	}
	if len(own) != 2 {
		t.Fatalf("own = %v", own)
	}
	if !olcSameRoom("meet.example.ru/room-1/", "https://MEET.example.ru/room-1") || olcSameRoom("", "") {
		t.Fatal("room comparison")
	}
	if strings.Contains(olcMaskKeys(out), key) {
		t.Fatal("key not masked")
	}
}

func TestOlcMarksVariantsDuringWhitelist(t *testing.T) {
	t.Setenv("MIHOMO_STATE_DIR", t.TempDir())
	now := time.Now().Unix()
	o := &olcState{path: olcStatePath(), st: olcStore{
		Servers: []*olcServer{{ID: "a", Variants: []olcVariant{{Node: "good"}, {Node: "bad"}, {Node: "old"}}}},
		Checks:  map[string]olcCheck{"good": {T: now, OK: true}, "bad": {T: now}, "old": {T: now - 3600, OK: true}},
	}}
	o.markWhitelist()
	v := o.st.Servers[0].Variants
	if v[0].WL != "ok" || v[1].WL != "fail" || v[2].WL != "" {
		t.Fatalf("marks = %q %q %q", v[0].WL, v[1].WL, v[2].WL)
	}
}

func TestOlcRoomsOfOtherServices(t *testing.T) {
	for _, c := range [][3]string{
		{"telemost", "https://telemost.yandex.ru/j/12345678901234", "12345678901234"},
		{"wbstream", "https://stream.wb.ru/room/abc-def/", "abc-def"},
		{"wbstream", "room-01", "room-01"},
		{"jitsi", "meet.example.ru/myroom/", "https://meet.example.ru/myroom"},
	} {
		if got := olcRoomID(c[0], c[1]); got != c[2] {
			t.Errorf("olcRoomID(%s, %s) = %s, want %s", c[0], c[1], got, c[2])
		}
	}
	if olcTransportFor("telemost", "datachannel") != "vp8channel" || olcTransportFor("wbstream", "seichannel") != "seichannel" || olcTransportFor("wbstream", "datachannel") != "vp8channel" {
		t.Fatal("transport matrix")
	}
	if olcProviderHost("telemost", "123") != "telemost.yandex.ru" || olcProviderHost("jitsi", "https://meet.x.ru/r") != "meet.x.ru" {
		t.Fatal("provider host")
	}
}
