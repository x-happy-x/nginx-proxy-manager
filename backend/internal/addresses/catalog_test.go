package addresses

import (
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"testing"
)

func TestCatalogAliasesAuthoritiesAndStableIdentity(t *testing.T) {
	r := schema.Routes{Apps: []schema.App{{ID: "account", Upstream: schema.UpstreamApp{Address: "192.168.99.33", Port: 4161}}, {ID: "service-42", AccountKey: "canvagents", Upstream: schema.UpstreamApp{Address: "192.168.99.35", Port: 4300}}}}
	for _, zone := range []string{"crubs.crazedns.ru", "cdn6.ru"} {
		r.Hosts = append(r.Hosts, schema.Host{Host: "account." + zone, AppID: "account", Endpoints: []schema.Endpoint{{Name: "web", Listen: schema.EndpointListen{Protocol: "https", Port: 443}}}})
		r.Hosts = append(r.Hosts, schema.Host{Host: "custom." + zone, AppID: "service-42", AccessApp: "canvagents", Publication: &schema.Publication{ServerID: "vps", HTTPSPort: 8443}, Endpoints: []schema.Endpoint{{Name: "vps", Listen: schema.EndpointListen{Protocol: "http", Port: 20000}}}})
	}
	c := Build(r)
	for _, zone := range []string{"crubs.crazedns.ru", "cdn6.ru"} {
		origin := "https://custom." + zone + ":8443"
		if c.AccountFor(origin) != "https://account."+zone {
			t.Fatal("Account authority inherited application port", c)
		}
		found := false
		for _, h := range c.Hosts {
			if h.Origin == origin {
				found = h.Service == "canvagents" && h.GatewayApp == "canvagents"
			}
		}
		if !found {
			t.Fatal("Explicit service identity lost", c)
		}
	}
	if c.AccountFor("https://unregistered.cdn6.ru") != "" {
		t.Fatal("Unregistered address admitted")
	}
	if c.AccountFor("http://192.168.99.35:4300") != "http://192.168.99.33:4161" {
		t.Fatal("LAN left local network")
	}
}
