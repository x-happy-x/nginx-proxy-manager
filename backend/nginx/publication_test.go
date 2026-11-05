package main

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"strings"
	"testing"
)

func TestPublicationUsesLoopbackAndKeepsGateway(t *testing.T) {
	r := testRoutes()
	r.Globals.AccessGateway = true
	r.Hosts = []schema.Host{{Host: "app.cdn6.ru", AppID: r.Apps[0].ID, Kind: "public", AccessApp: "homenet", Publication: &schema.Publication{ServerID: "vps"}, TLS: schema.TLSConfig{CertPolicy: "off"}, Endpoints: []schema.Endpoint{{Name: "vps", Listen: schema.EndpointListen{Protocol: "http", Port: 23001}}}}}
	files, err := testGenerator(t).render(r)
	if err != nil {
		t.Fatal(err)
	}
	site := ""
	for path, body := range files {
		if strings.HasSuffix(path, "app.cdn6.ru.conf") {
			site = body
		}
	}
	for _, want := range []string{"listen 127.0.0.1:23001;", "X-Forwarded-Proto https;", "auth_request /_gate/check;", "X-Gate-Proto https;", `"traffic_source":"external"`} {
		if !strings.Contains(site, want) {
			t.Fatalf("missing %q in %s", want, site)
		}
	}
	if strings.Contains(site, "listen 192.") || strings.Contains(site, "listen 0.0.0.0") {
		t.Fatal("tunnel exposed outside loopback")
	}
}
