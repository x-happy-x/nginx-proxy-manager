package main

import (
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func TestAccessDefaultsSkipPublicHosts(t *testing.T) {
	routes := schema.Routes{Hosts: []schema.Host{
		{Host: "ha.example", AppID: "ha", AccessApp: "homenet", AccessPublic: true},
		{Host: "git.example", AppID: "git"},
		{Host: "account.example", AppID: "account"},
		{Host: "lms.example", AppID: "lms-client"},
	}}
	previous := schema.Routes{Hosts: []schema.Host{{Host: "git.example", AccessIPPort: 22004}}}
	applyAccessDefaults(&routes, previous)
	if !routes.Globals.AccessGateway {
		t.Fatal("gateway must stay enabled")
	}
	want := map[string]string{"ha.example": "", "git.example": "homenet", "account.example": "", "lms.example": "lms_node"}
	for _, h := range routes.Hosts {
		if h.AccessApp != want[h.Host] {
			t.Fatalf("%s: access_app %q, want %q", h.Host, h.AccessApp, want[h.Host])
		}
	}
	if routes.Hosts[1].AccessIPPort != 22004 {
		t.Fatal("IP authority port must survive a save")
	}
}
