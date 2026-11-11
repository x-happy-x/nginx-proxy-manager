package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func lmsTestRoute() lmsEgressRoute {
	return lmsEgressRoute{ID: "eu", Label: "Europe", Proxy: "EU", Listen: "192.168.1.2", Port: 34000, Username: "lms-eu", Password: strings.Repeat("x", 43)}
}

func TestLMSListenersPreserveSharedGroupsAndRequireDedicatedOwnership(t *testing.T) {
	original := []byte("proxy-groups:\n  - name: Shared\n    type: select\n    proxies: [EU, DIRECT]\nlisteners:\n  - name: existing\n    type: socks\n    listen: 127.0.0.1\n    port: 33000\n")
	registry := lmsEgressRegistry{Routes: []lmsEgressRoute{lmsTestRoute()}}
	candidate, err := lmsListenerConfig(original, registry)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	yaml.Unmarshal(original, &before)
	yaml.Unmarshal(candidate, &after)
	if !reflect.DeepEqual(before["proxy-groups"], after["proxy-groups"]) {
		t.Fatal("shared groups were changed")
	}
	listeners := after["listeners"].([]any)
	if len(listeners) != 2 {
		t.Fatal("existing listener lost")
	}
	added := listeners[1].(map[string]any)
	if added["proxy"] != "EU" || added["type"] != "http" || added["port"] != 34000 {
		t.Fatal("route binding missing")
	}
	if len(added["users"].([]any)) != 1 {
		t.Fatal("authentication missing")
	}
	repeated, err := lmsListenerConfig(candidate, registry)
	if err != nil || !reflect.DeepEqual(candidate, repeated) {
		t.Fatal("not idempotent")
	}
	for _, bad := range []string{strings.Replace(string(original), "existing", "homenet-lms-eu", 1), strings.Replace(string(original), "33000", "34000", 1)} {
		if _, err := lmsListenerConfig([]byte(bad), registry); err == nil {
			t.Fatal("unowned collision accepted")
		}
	}
}

func TestLMSObservedPathsRequireNodeSourceAndExactHost(t *testing.T) {
	makeConn := func(source, host string) mihomoConn {
		var c mihomoConn
		c.Metadata.SourceIP = source
		c.Metadata.Host = host
		c.Chains = []string{"EU", "Shared"}
		c.Rule = "DomainSuffix"
		return c
	}
	connections := []mihomoConn{makeConn("192.168.99.33", "lesson.test"), makeConn("192.168.99.50", "secret.test"), makeConn("192.168.99.33", "cdn.test")}
	got := lmsObservedConnections(connections, "192.168.99.33", "lesson.test", time.Now())
	if len(got) != 1 || got[0].Host != "lesson.test" {
		t.Fatalf("wrong observations: %d", len(got))
	}
	if len(lmsObservedConnections(connections, "192.168.99.33", "unknown.test", time.Now())) != 0 {
		t.Fatal("invented route")
	}
}

func TestLMSRegistryIsBoundedAndPublicRoutesCannotLeakCredentials(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	registry := lmsEgressRegistry{Nodes: map[string]string{"home": "192.168.99.33"}, Routes: []lmsEgressRoute{lmsTestRoute()}}
	raw, _ := json.Marshal(registry)
	os.WriteFile(filepath.Join(dir, "lms-egress.json"), raw, 0600)
	if _, err := lmsRegistry(); err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(lmsPublicRoute{ID: registry.Routes[0].ID, Label: registry.Routes[0].Label, Available: true, Scope: "download"})
	if strings.Contains(string(public), registry.Routes[0].Password) || strings.Contains(string(public), "34000") {
		t.Fatal("private data leaked")
	}
	registry.Routes[0].Password = "weak"
	raw, _ = json.Marshal(registry)
	os.WriteFile(filepath.Join(dir, "lms-egress.json"), raw, 0600)
	if _, err := lmsRegistry(); err == nil {
		t.Fatal("weak unauthenticated listener accepted")
	}
}
