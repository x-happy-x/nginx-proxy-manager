package main

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func localDNSTestRoutes(names ...string) schema.Routes {
	r := schema.Routes{
		SchemaVersion: "2.1",
		Globals:       schema.Globals{ListenIPs: []string{"192.168.1.2"}},
		Apps:          []schema.App{{ID: "sub", Upstream: schema.UpstreamApp{Address: "192.168.99.20", Port: 4192, Scheme: "http"}}},
	}
	for _, name := range names {
		r.Hosts = append(r.Hosts, schema.Host{
			Host: name, AppID: "sub", DNS: schema.DNSConfig{Publish: []string{"local"}, LocalRecordIP: "auto"},
			Endpoints: []schema.Endpoint{{Name: "web", Listen: schema.EndpointListen{Protocol: "http", Port: 80}}},
		})
	}
	return r
}

type dnsRouterStub struct {
	records      map[string]map[string]bool
	calls        []string
	failAddHost  string
	failSaveOnce bool
	ignoreAdds   bool
}

func (s *dnsRouterStub) run(command string) (bool, string) {
	s.calls = append(s.calls, command)
	if command == "show running-config" {
		lines := []string{}
		for name, addresses := range s.records {
			for address := range addresses {
				lines = append(lines, fmt.Sprintf("ip host %s %s", name, address))
			}
		}
		sort.Strings(lines)
		return true, strings.Join(lines, "\n")
	}
	if command == "system configuration save" {
		if s.failSaveOnce {
			s.failSaveOnce = false
			return false, "save failed"
		}
		return true, "saved"
	}
	fields := strings.Fields(command)
	if len(fields) == 4 && fields[0] == "ip" && fields[1] == "host" {
		if !s.ignoreAdds {
			if s.records[fields[2]] == nil {
				s.records[fields[2]] = map[string]bool{}
			}
			s.records[fields[2]][fields[3]] = true
		}
		if fields[2] == s.failAddHost {
			return false, "timeout after command acceptance"
		}
		return true, "added"
	}
	if len(fields) == 5 && fields[0] == "no" && fields[1] == "ip" && fields[2] == "host" {
		delete(s.records[fields[3]], fields[4])
		return true, "removed exact address"
	}
	return false, "unexpected command: " + command
}

func TestLocalDNSPreflightsAllConflictsBeforeWrites(t *testing.T) {
	for _, addresses := range []map[string]bool{
		{"192.168.99.99": true},
		{"192.168.1.2": true, "192.168.99.99": true},
	} {
		stub := &dnsRouterStub{records: map[string]map[string]bool{"occupied.local": addresses}}
		a := &app{ndmcRunner: stub.run}
		ok, message := a.syncLocalDNS(localDNSTestRoutes("new.local", "occupied.local"))
		if ok || !strings.Contains(message, "no records changed") || len(stub.calls) != 1 {
			t.Fatalf("preflight performed writes: calls=%v result=%s", stub.calls, message)
		}
	}
}

func TestLocalDNSPreviewDoesNotWrite(t *testing.T) {
	stub := &dnsRouterStub{records: map[string]map[string]bool{}}
	if ok, message := (&app{ndmcRunner: stub.run}).previewLocalDNS(localDNSTestRoutes("sub.local", "sub.crubs.crazedns.ru")); !ok || !strings.Contains(message, "2 missing") {
		t.Fatal(message)
	}
	if len(stub.calls) != 1 || stub.calls[0] != "show running-config" {
		t.Fatalf("preview must only read current configuration: %v", stub.calls)
	}
}

func TestLocalDNSAddsOnlyMissingRecords(t *testing.T) {
	stub := &dnsRouterStub{records: map[string]map[string]bool{
		"existing.local": {"192.168.1.2": true},
		"foreign.local":  {"192.168.99.99": true},
	}}
	if ok, message := (&app{ndmcRunner: stub.run}).syncLocalDNS(localDNSTestRoutes("existing.local", "sub.crubs.crazedns.ru")); !ok {
		t.Fatal(message)
	}
	for _, call := range stub.calls {
		if strings.HasPrefix(call, "no ") || strings.HasPrefix(call, "ip host existing.local ") {
			t.Fatalf("existing record touched: %s", call)
		}
	}
	if !stub.records["sub.crubs.crazedns.ru"]["192.168.1.2"] || !stub.records["foreign.local"]["192.168.99.99"] {
		t.Fatal("incorrect resulting records")
	}
}

func TestLocalDNSFailureRollsBackExactNewRecordsAndSaves(t *testing.T) {
	for _, scenario := range []string{"accepted-timeout", "save-failure", "verification-failure"} {
		t.Run(scenario, func(t *testing.T) {
			stub := &dnsRouterStub{records: map[string]map[string]bool{"foreign.local": {"192.168.99.99": true}}}
			switch scenario {
			case "accepted-timeout":
				stub.failAddHost = "second.local"
			case "save-failure":
				stub.failSaveOnce = true
			case "verification-failure":
				stub.ignoreAdds = true
			}
			ok, message := (&app{ndmcRunner: stub.run}).syncLocalDNS(localDNSTestRoutes("first.local", "second.local"))
			if ok || !strings.Contains(message, "rollback saved") {
				t.Fatalf("unexpected recovery result: %s", message)
			}
			if len(stub.records["first.local"]) != 0 || len(stub.records["second.local"]) != 0 || !stub.records["foreign.local"]["192.168.99.99"] {
				t.Fatal("rollback failed or changed foreign records")
			}
			for _, call := range stub.calls {
				if strings.HasPrefix(call, "no ip host ") && len(strings.Fields(call)) != 5 {
					t.Fatalf("non-exact record removal: %s", call)
				}
			}
			if stub.calls[len(stub.calls)-2] != "system configuration save" || stub.calls[len(stub.calls)-1] != "show running-config" {
				t.Fatal("rollback was not saved and verified")
			}
		})
	}
}
