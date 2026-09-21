package schema

import (
	"os"
	"path/filepath"
	"testing"
)

func sampleRoutes() Routes {
	r := DefaultRoutes()
	r.Globals.ListenIPs = []string{"192.168.1.2"}
	r.Apps = []App{{ID: "sublab", Upstream: UpstreamApp{Address: "192.168.99.20", Port: 4192, Scheme: "http"}}}
	r.Hosts = []Host{{Host: "sub.crubs.crazedns.ru", AppID: "sublab", TLS: TLSConfig{CertPolicy: "off"}, Endpoints: []Endpoint{{Name: "web", Listen: EndpointListen{Protocol: "http", Port: 80}}, {Name: "ndns", Listen: EndpointListen{Protocol: "http", Port: "auto_random"}, Behavior: EndpointBehavior{NDNSName: "sub"}}}}}
	return r
}

func TestRejectUnsafeRoutes(t *testing.T) {
	tests := map[string]func(*Routes){
		"hostname injection":     func(r *Routes) { r.Hosts[0].Host = "sub.local; return 200;" },
		"path traversal":         func(r *Routes) { r.Hosts[0].Host = "../../nginx" },
		"unknown upstream":       func(r *Routes) { r.Hosts[0].AppID = "missing" },
		"upstream injection":     func(r *Routes) { r.Apps[0].Upstream.Address = "127.0.0.1;\ninclude /tmp/a" },
		"invalid port":           func(r *Routes) { r.Apps[0].Upstream.Port = 65536 },
		"fractional port":        func(r *Routes) { r.Hosts[0].Endpoints[0].Listen.Port = 80.5 },
		"listener injection":     func(r *Routes) { r.Globals.ListenIPs = []string{"0.0.0.0 default_server"} },
		"public local collision": func(r *Routes) { r.Hosts[0].Endpoints[1].Listen.Port = 80 },
		"mixed protocols": func(r *Routes) {
			r.Hosts[0].TLS.CertPolicy = "self_signed"
			r.Hosts[0].Endpoints[0].Listen.Protocol = "https"
		},
		"TLS without cert": func(r *Routes) {
			r.Hosts[0].Endpoints[0].Listen.Protocol = "https"
			r.Hosts[0].Endpoints[0].Listen.Port = 443
		},
		"NDMC injection":      func(r *Routes) { r.Hosts[0].Endpoints[1].Behavior.NDNSName = "sub\ninterface Bridge0 down" },
		"websocket injection": func(r *Routes) { r.Hosts[0].WSProxy.Path = "/; return 200;" },
		"duplicate hostname":  func(r *Routes) { r.Hosts = append(r.Hosts, r.Hosts[0]) },
		"schema version":      func(r *Routes) { r.SchemaVersion = "3.0" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			r := sampleRoutes()
			mutate(&r)
			if err := ValidateRoutes(r); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestResolveAutoPortsStableAndUnique(t *testing.T) {
	r := sampleRoutes()
	r.Globals.Ports.HTTPExtra = []int{20000}
	r.Globals.UI.Port = 20001
	r.Hosts = append(r.Hosts, Host{Host: "next.local", AppID: "sublab", TLS: TLSConfig{CertPolicy: "off"}, Endpoints: []Endpoint{{Name: "ndns", Listen: EndpointListen{Protocol: "http", Port: 20002}, Behavior: EndpointBehavior{NDNSName: "next"}}}})
	if err := ResolveAutoPorts(&r); err != nil {
		t.Fatal(err)
	}
	if got := NormalizePort(r.Hosts[0].Endpoints[1].Listen.Port, 0); got != 20003 {
		t.Fatalf("got %d", got)
	}
	if err := ResolveAutoPorts(&r); err != nil {
		t.Fatal(err)
	}
	if got := NormalizePort(r.Hosts[0].Endpoints[1].Listen.Port, 0); got != 20003 {
		t.Fatalf("port changed: %d", got)
	}
}

func TestNormalizeDoesNotMutateAndNDNSDefaultsToHTTP(t *testing.T) {
	r := sampleRoutes()
	r.Hosts[0].Endpoints[1].Listen.Protocol = ""
	n := NormalizeRoutes(r)
	if n.Hosts[0].Endpoints[1].Listen.Protocol != "http" {
		t.Fatal("KeenDNS transport must default to HTTP")
	}
	if r.Hosts[0].Endpoints[1].Listen.Protocol != "" {
		t.Fatal("normalization mutated caller")
	}
}

func TestSaveRejectsInvalidWithoutTouchingExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.yml")
	before := []byte("existing file\n")
	if err := os.WriteFile(path, before, 0o600); err != nil {
		t.Fatal(err)
	}
	r := sampleRoutes()
	r.Hosts[0].Host = "bad/name"
	if err := SaveRoutes(path, r); err == nil {
		t.Fatal("invalid save accepted")
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != string(before) {
		t.Fatalf("existing config changed: %q %v", body, err)
	}
}

func TestSaveLoadRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.yml")
	r := sampleRoutes()
	if err := ResolveAutoPorts(&r); err != nil {
		t.Fatal(err)
	}
	if err := SaveRoutes(path, r); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadRoutes(path)
	if err != nil {
		t.Fatal(err)
	}
	if NormalizePort(loaded.Hosts[0].Endpoints[1].Listen.Port, 0) != 20000 {
		t.Fatal("allocated port was not persisted")
	}
	if err := SaveRoutes(path, loaded); err != nil {
		t.Fatal("atomic replace failed", err)
	}
}

func TestRejectMultiplePublicEndpointsPerHost(t *testing.T) {
	r := sampleRoutes()
	r.Hosts[0].Endpoints = append(r.Hosts[0].Endpoints, Endpoint{
		Name:     "second-public",
		Listen:   EndpointListen{Protocol: "http", Port: 24002},
		Behavior: EndpointBehavior{NDNSProfile: "ndns_proxy", NDNSName: "second"},
	})
	if err := ValidateRoutes(r); err == nil {
		t.Fatal("manager can publish only one public endpoint per host")
	}
	// A normal local listener plus a single public listener remains supported.
	r.Hosts[0].Endpoints = r.Hosts[0].Endpoints[:2]
	if err := ValidateRoutes(r); err != nil {
		t.Fatal(err)
	}
	r.Hosts[0].Endpoints[0].Behavior.NDNSProfile = "ndns_proxy"
	if err := ValidateRoutes(r); err == nil {
		t.Fatal("local web listener cannot be selected by the NDNS publisher")
	}
}
