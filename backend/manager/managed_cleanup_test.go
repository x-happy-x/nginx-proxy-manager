package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

type managedRouterStub struct {
	proxies      map[string]ndnsProxy
	dns          map[string]map[string]bool
	calls        []string
	extra        map[string]string
	failAccepted string
}

func (s *managedRouterStub) run(command string) (bool, string) {
	s.calls = append(s.calls, command)
	if command == "show running-config" {
		lines := []string{}
		for name, addresses := range s.dns {
			for address := range addresses {
				lines = append(lines, fmt.Sprintf("ip host %s %s", name, address))
			}
		}
		sort.Strings(lines)
		names := []string{}
		for name := range s.proxies {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			p := s.proxies[name]
			lines = append(lines, "ip http proxy "+name,
				fmt.Sprintf(" upstream %s %s %s", p.Upstream.Proto, p.Upstream.Target, p.Upstream.Port),
				" domain "+p.Domain, " security-level "+p.SecurityLevel)
			if p.SSLRedirect {
				lines = append(lines, " ssl redirect")
			}
			if s.extra[name] != "" {
				lines = append(lines, " "+s.extra[name])
			}
			lines = append(lines, "!")
		}
		return true, strings.Join(lines, "\n")
	}
	f := strings.Fields(command)
	switch {
	case command == "system configuration save":
	case len(f) == 4 && f[0] == "ip" && f[1] == "host":
		if s.dns[f[2]] == nil {
			s.dns[f[2]] = map[string]bool{}
		}
		s.dns[f[2]][f[3]] = true
	case len(f) == 5 && strings.Join(f[:3], " ") == "no ip host":
		delete(s.dns[f[3]], f[4])
	case len(f) == 5 && strings.Join(f[:4], " ") == "no ip http proxy":
		delete(s.proxies, f[4])
	case len(f) >= 4 && strings.Join(f[:3], " ") == "ip http proxy":
		p := s.proxies[f[3]]
		p.Name = f[3]
		switch {
		case len(f) == 4:
		case len(f) == 8 && f[4] == "upstream":
			p.Upstream.Proto, p.Upstream.Target, p.Upstream.Port = f[5], f[6], f[7]
		case len(f) == 6 && f[4] == "domain":
			p.Domain = f[5]
		case len(f) == 6 && f[4] == "security-level":
			p.SecurityLevel = f[5]
		case len(f) == 6 && f[4] == "ssl" && f[5] == "redirect":
			p.SSLRedirect = true
		default:
			return false, "unexpected proxy command: " + command
		}
		s.proxies[p.Name] = p
	case len(f) == 7 && strings.Join(f[:4], " ") == "no ip http proxy" && f[5] == "ssl" && f[6] == "redirect":
		p := s.proxies[f[4]]
		p.SSLRedirect = false
		s.proxies[p.Name] = p
	default:
		return false, "unexpected command: " + command
	}
	if s.failAccepted == command {
		s.failAccepted = ""
		return false, "timeout after command acceptance"
	}
	return true, "ok"
}

func managedTestRoutes(names ...string) schema.Routes {
	r := localDNSTestRoutes()
	for i, name := range names {
		r.Hosts = append(r.Hosts, schema.Host{Host: name + ".crubs.crazedns.ru", AppID: "sub",
			DNS: schema.DNSConfig{Publish: []string{"local"}, LocalRecordIP: "auto"},
			Endpoints: []schema.Endpoint{{Name: "ndns", Listen: schema.EndpointListen{Protocol: "http", Port: 24192 + i},
				Behavior: schema.EndpointBehavior{NDNSName: name, NDNSTargetIP: "auto", NDNSProfile: "public"}}}})
	}
	return r
}

func stubForManagedRoutes(t *testing.T, routes schema.Routes) *managedRouterStub {
	t.Helper()
	proxies, dns, err := managedRouteEntries(routes, "")
	if err != nil {
		t.Fatal(err)
	}
	s := &managedRouterStub{proxies: proxies, dns: map[string]map[string]bool{}, extra: map[string]string{}}
	for pair := range dns {
		if s.dns[pair.host] == nil {
			s.dns[pair.host] = map[string]bool{}
		}
		s.dns[pair.host][pair.address] = true
	}
	return s
}

func assertManagedReadOnly(t *testing.T, s *managedRouterStub) {
	t.Helper()
	for _, call := range s.calls {
		if call != "show running-config" {
			t.Fatalf("unexpected mutation: %s", call)
		}
	}
}

func TestManagedCleanupDeletesOnlyPreviouslyOwnedExactRecords(t *testing.T) {
	previous := managedTestRoutes("old", "keep", "foreign")
	stub := stubForManagedRoutes(t, previous)
	previous.Hosts = previous.Hosts[:2] // Foreign live entries are not owned by the snapshot.
	stub.dns["old.crubs.crazedns.ru"]["192.168.99.99"] = true
	next := previous
	next.Hosts = next.Hosts[1:]
	a := &app{ndmcRunner: stub.run}
	plan, err := a.planManagedCleanup(&previous, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.proxies) != 1 || len(plan.dns) != 1 {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	journal := managedRouterJournal{}
	if err := a.applyManagedCleanup(plan, &journal); err != nil {
		t.Fatal(err)
	}
	if _, exists := stub.proxies["old"]; exists {
		t.Fatal("old proxy remains")
	}
	if stub.dns["old.crubs.crazedns.ru"]["192.168.1.2"] || !stub.dns["old.crubs.crazedns.ru"]["192.168.99.99"] {
		t.Fatal("wrong exact DNS record removed")
	}
	if len(stub.proxies) != 2 || !stub.dns["keep.crubs.crazedns.ru"]["192.168.1.2"] || !stub.dns["foreign.crubs.crazedns.ru"]["192.168.1.2"] {
		t.Fatal("unrelated entries changed")
	}
	for _, command := range stub.calls {
		if strings.HasPrefix(command, "no ip host ") && len(strings.Fields(command)) != 5 {
			t.Fatalf("unsafe non-exact deletion: %s", command)
		}
	}
}

func TestManagedCleanupMissingSnapshotAndAlreadyAbsentAreNoops(t *testing.T) {
	previous := managedTestRoutes("old")
	stub := stubForManagedRoutes(t, managedTestRoutes())
	a := &app{ndmcRunner: stub.run}
	plan, err := a.planManagedCleanup(nil, managedTestRoutes())
	if err != nil || len(plan.proxies)+len(plan.dns) != 0 || len(stub.calls) != 0 {
		t.Fatalf("missing snapshot inferred ownership: %+v %v %v", plan, err, stub.calls)
	}
	plan, err = a.planManagedCleanup(&previous, managedTestRoutes())
	if err != nil || len(plan.proxies)+len(plan.dns) != 0 {
		t.Fatalf("already absent entries: %+v %v", plan, err)
	}
	if err := a.applyManagedCleanup(plan, &managedRouterJournal{}); err != nil {
		t.Fatal(err)
	}
	assertManagedReadOnly(t, stub)
}

func TestManagedCleanupDisabledAndSharedNames(t *testing.T) {
	for _, scenario := range []string{"disabled", "retained-name", "rename"} {
		t.Run(scenario, func(t *testing.T) {
			previous := managedTestRoutes("old")
			stub := stubForManagedRoutes(t, previous)
			next := managedTestRoutes("new")
			switch scenario {
			case "disabled":
				next = managedTestRoutes("old")
				next.Hosts[0].DNS.Publish = nil
				next.Hosts[0].Endpoints = nil
			case "retained-name":
				next.Hosts[0].Endpoints[0].Behavior.NDNSName = "old"
			}
			plan, err := (&app{ndmcRunner: stub.run}).planManagedCleanup(&previous, next)
			if err != nil {
				t.Fatal(err)
			}
			wantProxies := 1
			if scenario == "retained-name" {
				wantProxies = 0
			}
			if len(plan.proxies) != wantProxies || len(plan.dns) != 1 {
				t.Fatalf("unexpected plan: %+v", plan)
			}
			assertManagedReadOnly(t, stub)
		})
	}
}

func TestManagedOwnershipDriftFailsBeforeAnyMutation(t *testing.T) {
	for _, drift := range []string{"target", "port", "proto", "security", "domain", "ssl", "dns", "unknown-directive", "duplicate-directive"} {
		t.Run(drift, func(t *testing.T) {
			previous := managedTestRoutes("old")
			stub := stubForManagedRoutes(t, previous)
			p := stub.proxies["old"]
			switch drift {
			case "target":
				p.Upstream.Target = "192.168.99.99"
			case "port":
				p.Upstream.Port = "4192"
			case "proto":
				p.Upstream.Proto = "https"
			case "security":
				p.SecurityLevel = "private"
			case "domain":
				p.Domain = "foreign.example"
			case "ssl":
				p.SSLRedirect = !p.SSLRedirect
			case "dns":
				stub.dns["old.crubs.crazedns.ru"] = map[string]bool{"192.168.99.99": true}
			case "unknown-directive":
				stub.extra["old"] = "operator-option enabled"
			case "duplicate-directive":
				stub.extra["old"] = "domain ndns"
			}
			stub.proxies["old"] = p
			if _, err := (&app{ndmcRunner: stub.run}).planManagedCleanup(&previous, managedTestRoutes()); err == nil {
				t.Fatal("drift accepted")
			}
			assertManagedReadOnly(t, stub)
		})
	}
}

func TestManagedOwnershipUsesHistoricalTargetsOnlyAndFirstEndpoint(t *testing.T) {
	previous := managedTestRoutes("old")
	stub := stubForManagedRoutes(t, previous)
	a := &app{nginxListenIPs: "192.168.99.88", ndmcRunner: stub.run}
	next := managedTestRoutes()
	next.Globals.ListenIPs = []string{"192.168.99.88"}
	if plan, err := a.planManagedCleanup(&previous, next); err != nil || plan.dns[0].address != "192.168.1.2" {
		t.Fatalf("historical IP replaced: %+v %v", plan, err)
	}
	previous.Globals.ListenIPs = nil
	if _, err := a.planManagedCleanup(&previous, next); err == nil {
		t.Fatal("inferred historical auto target from current environment")
	}
	previous.Hosts[0].DNS.LocalRecordIP = "192.168.1.2"
	previous.Hosts[0].Endpoints[0].Behavior.NDNSTargetIP = "192.168.1.2"
	other := previous.Hosts[0].Endpoints[0]
	other.Behavior.NDNSName = "never-owned"
	other.Listen.Port = 24199
	previous.Hosts[0].Endpoints = append(previous.Hosts[0].Endpoints, other)
	proxies, _, err := managedRouteEntries(previous, "")
	if err != nil || len(proxies) != 1 || proxies["old"].Name != "old" {
		t.Fatalf("claimed extra endpoint: %v %v", proxies, err)
	}
}

func TestManagedCleanupRevalidatesAllBeforeDeleting(t *testing.T) {
	previous := managedTestRoutes("first", "second")
	stub := stubForManagedRoutes(t, previous)
	a := &app{ndmcRunner: stub.run}
	plan, err := a.planManagedCleanup(&previous, managedTestRoutes())
	if err != nil {
		t.Fatal(err)
	}
	p := stub.proxies["second"]
	p.SecurityLevel = "private"
	stub.proxies["second"] = p
	if err := a.applyManagedCleanup(plan, &managedRouterJournal{}); err == nil {
		t.Fatal("concurrent drift accepted")
	}
	assertManagedReadOnly(t, stub)
}

func TestManagedCleanupFailureRestoresRemovedAndNewEntries(t *testing.T) {
	for _, failure := range []string{"no ip http proxy old", "no ip host old.crubs.crazedns.ru 192.168.1.2", "system configuration save", "later-snapshot-save"} {
		t.Run(failure, func(t *testing.T) {
			previous := managedTestRoutes("old", "foreign")
			stub := stubForManagedRoutes(t, previous)
			previous.Hosts = previous.Hosts[:1]
			next := managedTestRoutes("new")
			a := &app{ndmcRunner: stub.run}
			before, err := a.currentProxies()
			if err != nil {
				t.Fatal(err)
			}
			beforeMap, _ := proxyState(before)
			plan, err := a.planManagedCleanup(&previous, next)
			if err != nil {
				t.Fatal(err)
			}
			adds, err := a.planLocalDNS(next)
			if err != nil {
				t.Fatal(err)
			}
			journal := managedRouterJournal{}
			if err := a.addManagedDNS(adds, &journal); err != nil {
				t.Fatal(err)
			}
			if err := a.syncManagedProxies(next, beforeMap, &journal); err != nil {
				t.Fatal(err)
			}
			stub.failAccepted = failure
			err = a.applyManagedCleanup(plan, &journal)
			if (err == nil) != (failure == "later-snapshot-save") {
				t.Fatalf("unexpected failure: %v", err)
			}
			messages := a.rollbackManagedRouter(journal, beforeMap)
			if strings.Contains(strings.Join(messages, "\n"), "FAILED") {
				t.Fatalf("rollback errors: %v", messages)
			}
			if !reflect.DeepEqual(stub.proxies, beforeMap) {
				t.Fatalf("public rollback mismatch: %v vs %v", stub.proxies, beforeMap)
			}
			if !stub.dns["old.crubs.crazedns.ru"]["192.168.1.2"] || len(stub.dns["new.crubs.crazedns.ru"]) != 0 || !stub.dns["foreign.crubs.crazedns.ru"]["192.168.1.2"] {
				t.Fatalf("DNS rollback mismatch: %v", stub.dns)
			}
		})
	}
}

func TestManagedRollbackTouchesOnlyAttemptedChanges(t *testing.T) {
	previous := managedTestRoutes("untouched")
	stub := stubForManagedRoutes(t, previous)
	a := &app{ndmcRunner: stub.run}
	before, _ := a.currentProxies()
	beforeMap, _ := proxyState(before)
	stub.failAccepted = "ip host first.local 192.168.1.2"
	journal := managedRouterJournal{}
	if err := a.addManagedDNS([]localDNSChange{{"first.local", "192.168.1.2"}, {"unattempted.local", "192.168.1.2"}}, &journal); err == nil {
		t.Fatal("expected timeout")
	}
	// Another operator modifies entries that this failed transaction never touched.
	p := stub.proxies["untouched"]
	p.Upstream.Port = "9999"
	stub.proxies[p.Name] = p
	stub.dns["unattempted.local"] = map[string]bool{"192.168.1.2": true}
	a.rollbackManagedRouter(journal, beforeMap)
	if stub.proxies["untouched"] != p || !stub.dns["unattempted.local"]["192.168.1.2"] || len(stub.dns["first.local"]) != 0 {
		t.Fatal("rollback touched unrelated changes")
	}
}

func TestReadAppliedOwnershipDistinguishesAbsenceAndInvalidSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "applied.yml")
	t.Setenv("APPLIED_ROUTES_PATH", path)
	a := &app{}
	if prior, err := a.readAppliedOwnership(); prior != nil || err != nil {
		t.Fatalf("missing snapshot: %v %v", prior, err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := a.readAppliedOwnership(); err == nil {
		t.Fatal("directory treated as absent snapshot")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("invalid: ["), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.readAppliedOwnership(); err == nil {
		t.Fatal("invalid YAML treated as absent snapshot")
	}
	if err := schema.SaveRoutes(path, managedTestRoutes("old")); err != nil {
		t.Fatal(err)
	}
	if prior, err := a.readAppliedOwnership(); err != nil || len(prior.Hosts) != 1 {
		t.Fatalf("valid snapshot rejected: %v %v", prior, err)
	}
}

func TestManagedTargetMigrationStillFailsClosed(t *testing.T) {
	previous := managedTestRoutes("same")
	stub := stubForManagedRoutes(t, previous)
	next := managedTestRoutes("same")
	next.Globals.ListenIPs = []string{"192.168.1.3"}
	a := &app{ndmcRunner: stub.run}
	if _, err := a.planLocalDNS(next); err == nil {
		t.Fatal("same hostname IP migration unexpectedly accepted")
	}
	assertManagedReadOnly(t, stub)
}
