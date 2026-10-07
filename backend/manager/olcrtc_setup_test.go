package main

import (
	"strings"
	"testing"
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
