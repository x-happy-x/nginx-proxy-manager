package schema

import (
	"path/filepath"
	"testing"
)

func publicationRoutes() Routes {
	r := sampleRoutes()
	r.Hosts = []Host{}
	for _, name := range []string{"sub.cdn6.ru", "sub.other.example"} {
		r.Hosts = append(r.Hosts, Host{Host: name, Kind: "public", AppID: "sublab", Publication: &Publication{ServerID: "vps"}, TLS: TLSConfig{CertPolicy: "off"}, Endpoints: []Endpoint{{Name: "vps", Listen: EndpointListen{Protocol: "http", Port: "auto_random"}}}})
	}
	return r
}

func TestPublicationPortsAndRoundTrip(t *testing.T) {
	r := publicationRoutes()
	if err := ResolveAutoPorts(&r); err != nil {
		t.Fatal(err)
	}
	if r.Hosts[0].Endpoints[0].Listen.Port == r.Hosts[1].Endpoints[0].Listen.Port {
		t.Fatal("public listeners must be distinct")
	}
	path := filepath.Join(t.TempDir(), "routes.yml")
	if err := SaveRoutes(path, r); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadRoutes(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Hosts) != 2 || loaded.Hosts[1].Publication.ServerID != "vps" {
		t.Fatal("publication lost")
	}
	if err := ResolveAutoPorts(&loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.Hosts[0].Endpoints[0].Listen.Port != r.Hosts[0].Endpoints[0].Listen.Port {
		t.Fatal("reapply reassigned port")
	}
}

func TestPublicationRejectsUnsafeEndpoints(t *testing.T) {
	for name, change := range map[string]func(*Host){
		"no server":       func(h *Host) { h.Publication.ServerID = "" },
		"local DNS loop":  func(h *Host) { h.DNS.Publish = []string{"local"} },
		"web listener":    func(h *Host) { h.Endpoints[0].Name = "web" },
		"KeenDNS":         func(h *Host) { h.Endpoints[0].Behavior.NDNSProfile = "ndns_proxy" },
		"privileged port": func(h *Host) { h.Endpoints[0].Listen.Port = 22 },
		"no publication":  func(h *Host) { h.Publication = nil },
	} {
		t.Run(name, func(t *testing.T) {
			r := publicationRoutes()
			change(&r.Hosts[0])
			if ValidateRoutes(r) == nil {
				t.Fatal("unsafe publication accepted")
			}
		})
	}
}
