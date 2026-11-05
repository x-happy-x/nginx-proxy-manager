package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func TestPublicationSwitchPreservesLANAndSeparatesProviders(t *testing.T) {
	g := newGenerator(t.TempDir())
	g.preview = true
	r := testRoutes()
	r.Hosts = append(r.Hosts, schema.Host{Host: "app.cdn6.ru", AppID: "sublab", Kind: "public", Publication: &schema.Publication{ServerID: "cdn6"}, TLS: schema.TLSConfig{CertPolicy: "public_vps"}, DNS: schema.DNSConfig{Publish: []string{"local"}}, Endpoints: []schema.Endpoint{{Name: "web", Listen: schema.EndpointListen{Protocol: "https", Port: 443}}, {Name: "vps", Listen: schema.EndpointListen{Protocol: "http", Port: 24500}}}})
	r.Globals.DisabledPublications = []string{"vps:cdn6"}
	files, err := g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	vps := files[filepath.Join(g.sitesEnabled, "app.cdn6.ru.conf")]
	keen := files[filepath.Join(g.sitesEnabled, r.Hosts[0].Host+".conf")]
	if !strings.Contains(vps, "listen 192.168.1.2:443 ssl;") || !strings.Contains(vps, `"traffic_source":"local"`) || strings.Contains(vps, "127.0.0.1:24500") {
		t.Fatal("VPS switch affected LAN or retained reverse entrance")
	}
	if !strings.Contains(keen, ":24001;") {
		t.Fatal("VPS switch affected KeenDNS")
	}
	r.Globals.DisabledPublications = []string{"keendns:ndns_proxy"}
	files, err = g.render(r)
	if err != nil {
		t.Fatal(err)
	}
	vps = files[filepath.Join(g.sitesEnabled, "app.cdn6.ru.conf")]
	keen = files[filepath.Join(g.sitesEnabled, r.Hosts[0].Host+".conf")]
	if !strings.Contains(vps, "127.0.0.1:24500") || strings.Contains(keen, ":24001;") || !strings.Contains(keen, ":80;") {
		t.Fatal("KeenDNS switch isolation failed")
	}
	if exists(filepath.Join(g.confRoot, "public-certs")) {
		t.Fatal("preview wrote certificate files")
	}
	g.preview = false
	if _, err = g.render(r); err == nil {
		t.Fatal("missing real certificate must block activating LAN DNS")
	}
}
