package main

import (
	"strings"
	"testing"
)

func TestGatewayProtectsRoutesAndWebSockets(t *testing.T) {
	r := testRoutes()
	r.Globals.AccessGateway = true
	r.Hosts[0].AccessApp = "homenet"
	r.Hosts[0].WSProxy.Enabled = true
	r.Hosts[0].WSProxy.Path = "/socket"
	g := testGenerator(t)
	files, e := g.render(r)
	if e != nil {
		t.Fatal(e)
	}
	var site string
	for p, b := range files {
		if strings.HasSuffix(p, r.Hosts[0].Host+".conf") {
			site = b
		}
	}
	if strings.Count(site, "auth_request /_gate/check;") != 4 {
		t.Fatal("all local/public and websocket locations must be protected")
	}
	if !strings.Contains(site, "internal;") || !strings.Contains(site, "X-Gate-Proto https;") {
		t.Fatal("trusted external protocol or internal boundary missing")
	}
	r.Globals.AccessGateway = false
	files, e = g.render(r)
	if e != nil {
		t.Fatal(e)
	}
	for _, b := range files {
		if strings.Contains(b, "auth_request") {
			t.Fatal("disabled gateway changed routes")
		}
	}
}
