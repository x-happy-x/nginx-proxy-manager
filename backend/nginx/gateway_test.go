package main

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"strings"
	"testing"
)

func TestGatewayProtectsRoutesAndWebSockets(t *testing.T) {
	r := testRoutes()
	r.Globals.AccessGateway = true
	r.Hosts[0].AccessApp = "homenet"
	r.Hosts[0].WSProxy.Enabled = true
	r.Hosts[0].WSProxy.Path = "/socket"
	r = schema.NormalizeRoutes(r)
	if !r.Globals.AccessGateway {
		t.Fatal("normalization dropped gateway policy")
	}
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

func TestLMSAPIKeepsAuthWithoutBrowserRedirect(t *testing.T) {
	r := testRoutes()
	r.Globals.AccessGateway = true
	r.Hosts[0].AccessApp = "lms_node"
	files, err := testGenerator(t).render(r)
	if err != nil {
		t.Fatal(err)
	}
	var site string
	for p, b := range files {
		if strings.HasSuffix(p, r.Hosts[0].Host+".conf") {
			site = b
		}
	}
	for _, want := range []string{"location ^~ /api/ui/ {", "error_page 401 = @lms_api_401;", "return 401 '{\"error\":", "proxy_set_header Authorization $http_authorization;", "proxy_set_header Authorization \"\";"} {
		if !strings.Contains(site, want) {
			t.Fatal("missing " + want)
		}
	}
	if strings.Count(site, "auth_request /_gate/check;") != 4 {
		t.Fatal("local and external API must stay protected")
	}
}

func TestGatewayIPLinksKeepAuthorityAndProtection(t *testing.T) {
	r := testRoutes()
	r.Globals.AccessGateway = true
	r.Hosts[0].AccessApp = "homenet"
	r.Hosts[0].AccessIPPort = 22004
	g := testGenerator(t)
	files, e := g.render(r)
	if e != nil {
		t.Fatal(e)
	}
	var all string
	for _, b := range files {
		all += b
	}
	if !strings.Contains(all, ":22004") || !strings.Contains(all, "proxy_set_header X-Gate-Host "+r.Globals.ListenIPs[0]+":22004;") {
		t.Fatal("IP authority missing")
	}
	if strings.Count(all, "auth_request /_gate/check;") < 3 {
		t.Fatal("IP route unprotected")
	}
}
