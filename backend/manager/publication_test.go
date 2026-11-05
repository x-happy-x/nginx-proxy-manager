package main

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"testing"
)

func TestDisabledPublicationRemovesManagedKeenDNSButRetainsDNSAndVPSNames(t *testing.T) {
	r := schema.DefaultRoutes()
	r.Globals.ListenIPs = []string{"192.168.1.2"}
	r.Hosts = []schema.Host{{Host: "app.example", DNS: schema.DNSConfig{Publish: []string{"local"}}, Endpoints: []schema.Endpoint{{Name: "ndns", Listen: schema.EndpointListen{Protocol: "http", Port: 24500}, Behavior: schema.EndpointBehavior{NDNSProfile: "ndns_proxy", NDNSName: "app"}}}}, {Host: "app.cdn6.ru", Publication: &schema.Publication{ServerID: "cdn6"}, TLS: schema.TLSConfig{CertPolicy: "public_vps"}, Endpoints: []schema.Endpoint{{Name: "vps", Listen: schema.EndpointListen{Protocol: "http", Port: 24501}}}}}
	before, dns, err := managedRouteEntries(r, "")
	if err != nil || len(before) != 1 || len(dns) != 1 {
		t.Fatal(before, dns, err)
	}
	r.Globals.DisabledPublications = []string{"keendns:ndns_proxy", "vps:cdn6"}
	after, dns, err := managedRouteEntries(r, "")
	if err != nil || len(after) != 0 || len(dns) != 1 {
		t.Fatal("switch discarded local DNS or retained KeenDNS", err)
	}
	forwards := publicForwards(r, "cdn6")
	if len(forwards) != 1 || !forwards[0].Disabled || !forwards[0].Local {
		t.Fatal("remote must retain domain/certificate while disabling reverse forward")
	}
}
