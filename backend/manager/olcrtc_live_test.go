package main

import (
	"os"
	"testing"
	"time"
)

// OLC_LIVE=host reads what runs on a real server (needs the router's key in MIHOMO_STATE_DIR); changes nothing.
func TestOlcLiveExisting(t *testing.T) {
	host := os.Getenv("OLC_LIVE")
	if host == "" {
		t.Skip("OLC_LIVE not set")
	}
	x, _, err := olcDial(&olcServer{Host: host, Port: 22, User: "root"}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer x.c.Close()
	out, err := x.root(olcExistingCmd, 40*time.Second)
	t.Logf("err=%v\n%s", err, olcMaskKeys(out))
	found, own := parseOlcExisting(out)
	for _, f := range found {
		t.Logf("found %s %s dir=%s tmp=%v %s %s %s key=%v", f.Container, f.Status, f.Dir, f.InTmp, f.Provider, f.Room, f.Transport, len(f.key) == 64)
	}
	t.Logf("own=%v", own)
}
