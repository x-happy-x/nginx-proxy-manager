package main

import (
	"fmt"
	"net"
	"os"
	"sort"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"gopkg.in/yaml.v3"
)

func (a *app) readAppliedOwnership() (*schema.Routes, error) {
	body, err := os.ReadFile(a.appliedRoutesPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read previous applied routes: %w", err)
	}
	var routes schema.Routes
	if err := yaml.Unmarshal(body, &routes); err != nil {
		return nil, fmt.Errorf("cannot parse previous applied routes: %w", err)
	}
	if routes.SchemaVersion != "2.1" {
		return nil, schema.ErrSchemaVersion
	}
	if err := schema.ValidateRoutes(routes); err != nil {
		return nil, fmt.Errorf("invalid previous applied routes: %w", err)
	}
	routes = schema.NormalizeRoutes(routes)
	return &routes, nil
}

// Unknown or repeated directives may contain operator settings that our typed
// snapshot cannot reconstruct. Reject those owned stanzas instead of deleting
// or overwriting information we do not understand.
func (a *app) managedProxyState(watched map[string]bool) (map[string]ndnsProxy, error) {
	ok, raw := a.runNDMC("show running-config")
	if !ok {
		return nil, fmt.Errorf("read KeenDNS: %s", raw)
	}
	name := ""
	seen := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") || strings.TrimSpace(line) == "!" {
			name = ""
			if len(fields) == 4 && strings.Join(fields[:3], " ") == "ip http proxy" {
				name = fields[3]
				seen = map[string]bool{}
			}
			continue
		}
		if !watched[name] {
			continue
		}
		known := len(fields) == 4 && fields[0] == "upstream" || len(fields) == 2 && (fields[0] == "domain" || fields[0] == "security-level" || fields[0] == "ssl" && fields[1] == "redirect")
		if !known || seen[fields[0]] {
			return nil, fmt.Errorf("KeenDNS %s contains unsupported or repeated directives; no records changed", name)
		}
		seen[fields[0]] = true
	}
	return proxyState(parseNDNSHTTPConfig(raw).Proxies)
}

// The applied snapshot is the ownership boundary. A UI draft or a matching
// router record alone never grants permission to remove a record.
type managedCleanupPlan struct {
	proxies []ndnsProxy
	dns     []localDNSChange
}

type managedRouterJournal struct {
	proxies    []string
	dnsAdded   []localDNSChange
	dnsRemoved []localDNSChange
}

func (j *managedRouterJournal) touchProxy(name string) {
	if !contains(j.proxies, name) {
		j.proxies = append(j.proxies, name)
	}
}

func managedRouteEntries(routes schema.Routes, fallbackIPs string) (map[string]ndnsProxy, map[localDNSChange]bool, error) {
	ips := routes.Globals.ListenIPs
	if len(ips) == 0 && fallbackIPs != "" {
		ips = schema.ParseListenIPs(fallbackIPs)
	}
	proxies := map[string]ndnsProxy{}
	dns := map[localDNSChange]bool{}
	for _, host := range routes.Hosts {
		if hasString(host.DNS.Publish, "local") {
			address := host.DNS.LocalRecordIP
			if address == "" || address == "auto" {
				if len(ips) == 0 {
					return nil, nil, fmt.Errorf("cannot prove previous DNS ownership for %s: snapshot has no explicit listener IP", host.Host)
				}
				address = ips[0]
			}
			ip := net.ParseIP(address)
			if !validRouterHost(host.Host) || ip == nil {
				return nil, nil, fmt.Errorf("invalid managed DNS ownership for %s", host.Host)
			}
			dns[localDNSChange{strings.ToLower(host.Host), ip.String()}] = true
		}
		// syncNDNSFromRoutes owns only the first effective NDNS endpoint.
		for _, endpoint := range host.Endpoints {
			if endpoint.Behavior.NDNSProfile == "" && !strings.EqualFold(strings.TrimSpace(endpoint.Name), "ndns") {
				continue
			}
			if schema.NormalizePort(endpoint.Listen.Port, 0) == 0 {
				return nil, nil, fmt.Errorf("cannot prove previous public ownership for %s: snapshot has an unresolved port", host.Host)
			}
			if (endpoint.Behavior.NDNSTargetIP == "" || endpoint.Behavior.NDNSTargetIP == "auto") && len(ips) == 0 {
				return nil, nil, fmt.Errorf("cannot prove previous public ownership for %s: snapshot has no explicit target IP", host.Host)
			}
			break
		}
		if payload := hostNDNSPayload(host, ips); payload != nil {
			proxy, err := proxyFromPayload(payload)
			if err != nil {
				return nil, nil, err
			}
			if prior, exists := proxies[proxy.Name]; exists && prior != proxy {
				return nil, nil, fmt.Errorf("ambiguous managed public ownership for %s", proxy.Name)
			}
			proxies[proxy.Name] = proxy
		}
	}
	return proxies, dns, nil
}

func proxyState(items []ndnsProxy) (map[string]ndnsProxy, error) {
	result := map[string]ndnsProxy{}
	for _, proxy := range items {
		if prior, exists := result[proxy.Name]; exists && prior != proxy {
			return nil, fmt.Errorf("ambiguous live KeenDNS proxy %s; no records changed", proxy.Name)
		}
		result[proxy.Name] = proxy
	}
	return result, nil
}

func (a *app) planManagedCleanup(previous *schema.Routes, next schema.Routes) (managedCleanupPlan, error) {
	plan := managedCleanupPlan{}
	if previous == nil {
		return plan, nil
	}
	// Never use today's environment to infer a historical auto target.
	ownedProxies, ownedDNS, err := managedRouteEntries(*previous, "")
	if err != nil {
		return plan, err
	}
	wantedProxies, wantedDNS, err := managedRouteEntries(next, a.nginxListenIPs)
	if err != nil {
		return plan, err
	}
	watched := map[string]bool{}
	for name := range ownedProxies {
		watched[name] = true
	}
	currentProxies, err := a.managedProxyState(watched)
	if err != nil {
		return plan, err
	}
	currentDNS, err := a.readLocalDNSRecords()
	if err != nil {
		return plan, err
	}
	for name, owned := range ownedProxies {
		actual, exists := currentProxies[name]
		if exists && actual != owned {
			return plan, fmt.Errorf("KeenDNS %s differs from the applied snapshot; no records changed", name)
		}
		if _, keep := wantedProxies[name]; !keep && exists {
			plan.proxies = append(plan.proxies, owned)
		}
	}
	for owned := range ownedDNS {
		if wantedDNS[owned] {
			continue
		}
		addresses := currentDNS[owned.host]
		if !addresses[owned.address] && len(addresses) > 0 {
			return plan, fmt.Errorf("DNS %s differs from the applied snapshot; no records changed", owned.host)
		}
		if addresses[owned.address] {
			plan.dns = append(plan.dns, owned)
		}
	}
	sort.Slice(plan.proxies, func(i, j int) bool { return plan.proxies[i].Name < plan.proxies[j].Name })
	sort.Slice(plan.dns, func(i, j int) bool {
		if plan.dns[i].host == plan.dns[j].host {
			return plan.dns[i].address < plan.dns[j].address
		}
		return plan.dns[i].host < plan.dns[j].host
	})
	return plan, nil
}

func (a *app) applyManagedCleanup(plan managedCleanupPlan, journal *managedRouterJournal) error {
	if len(plan.proxies)+len(plan.dns) == 0 {
		return nil
	}
	// Recheck the entire removal set after the additions and nginx reload. No
	// deletion is issued if an operator changed any candidate since preflight.
	watched := map[string]bool{}
	for _, proxy := range plan.proxies {
		watched[proxy.Name] = true
	}
	currentProxies, err := a.managedProxyState(watched)
	if err != nil {
		return err
	}
	currentDNS, err := a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, proxy := range plan.proxies {
		if actual, exists := currentProxies[proxy.Name]; exists && actual != proxy {
			return fmt.Errorf("KeenDNS %s changed during apply; cleanup refused", proxy.Name)
		}
	}
	for _, record := range plan.dns {
		if addresses := currentDNS[record.host]; len(addresses) > 0 && !addresses[record.address] {
			return fmt.Errorf("DNS %s changed during apply; cleanup refused", record.host)
		}
	}
	for _, proxy := range plan.proxies {
		if _, exists := currentProxies[proxy.Name]; !exists {
			continue
		}
		journal.touchProxy(proxy.Name) // Include uncertain timeout-after-acceptance.
		if ok, out := a.runNDMC("no ip http proxy " + proxy.Name); !ok {
			return fmt.Errorf("remove managed KeenDNS %s: %s", proxy.Name, out)
		}
	}
	for _, record := range plan.dns {
		if !currentDNS[record.host][record.address] {
			continue
		}
		journal.dnsRemoved = append(journal.dnsRemoved, record)
		if ok, out := a.runNDMC("no ip host " + record.host + " " + record.address); !ok {
			return fmt.Errorf("remove managed DNS %s: %s", record.host, out)
		}
	}
	if ok, out := a.runNDMC("system configuration save"); !ok {
		return fmt.Errorf("save managed cleanup: %s", out)
	}
	currentProxies, err = a.managedProxyState(watched)
	if err != nil {
		return err
	}
	currentDNS, err = a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, proxy := range plan.proxies {
		if _, exists := currentProxies[proxy.Name]; exists {
			return fmt.Errorf("managed KeenDNS removal verification failed for %s", proxy.Name)
		}
	}
	for _, record := range plan.dns {
		if currentDNS[record.host][record.address] {
			return fmt.Errorf("managed DNS removal verification failed for %s", record.host)
		}
	}
	return nil
}

func (a *app) addManagedDNS(records []localDNSChange, journal *managedRouterJournal) error {
	if len(records) == 0 {
		return nil
	}
	current, err := a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, record := range records {
		if len(current[record.host]) > 0 {
			return fmt.Errorf("DNS %s changed during apply; additions refused", record.host)
		}
	}
	for _, record := range records {
		journal.dnsAdded = append(journal.dnsAdded, record)
		if ok, out := a.runNDMC("ip host " + record.host + " " + record.address); !ok {
			return fmt.Errorf("add managed DNS %s: %s", record.host, out)
		}
	}
	current, err = a.readLocalDNSRecords()
	if err != nil {
		return err
	}
	for _, record := range records {
		if len(current[record.host]) != 1 || !current[record.host][record.address] {
			return fmt.Errorf("managed DNS addition verification failed for %s", record.host)
		}
	}
	if ok, out := a.runNDMC("system configuration save"); !ok {
		return fmt.Errorf("save managed DNS additions: %s", out)
	}
	return nil
}

func (a *app) syncManagedProxies(routes schema.Routes, before map[string]ndnsProxy, journal *managedRouterJournal) error {
	wanted, _, err := managedRouteEntries(routes, a.nginxListenIPs)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(wanted))
	for name := range wanted {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		next := wanted[name]
		current, err := a.managedProxyState(map[string]bool{name: true})
		if err != nil {
			return err
		}
		actual, present := current[name]
		old, existed := before[name]
		if present != existed || present && actual != old {
			return fmt.Errorf("KeenDNS %s changed during apply; update refused", name)
		}
		if present && actual == next {
			continue
		}
		journal.touchProxy(name)
		payload := map[string]any{"name": next.Name, "domain": next.Domain, "securityLevel": next.SecurityLevel, "sslRedirect": next.SSLRedirect, "upstream": map[string]any{"proto": next.Upstream.Proto, "target": next.Upstream.Target, "port": next.Upstream.Port}}
		if ok, out := a.upsertNDNS(payload, ""); !ok {
			return fmt.Errorf("KeenDNS %s: %s", name, out)
		}
	}
	return nil
}

func (a *app) rollbackManagedRouter(journal managedRouterJournal, before map[string]ndnsProxy) []string {
	messages := []string{}
	if len(journal.proxies) > 0 {
		items, err := a.currentProxies()
		if err != nil {
			messages = append(messages, "Cannot verify public rollback: "+err.Error())
		} else if current, err := proxyState(items); err != nil {
			messages = append(messages, err.Error())
		} else {
			for _, name := range journal.proxies {
				old, existed := before[name]
				actual, present := current[name]
				if existed && present && old == actual || !existed && !present {
					continue
				}
				var prior *ndnsProxy
				if existed {
					copy := old
					prior = &copy
				}
				messages = append(messages, a.restoreProxy(prior, name))
			}
			verified, err := a.currentProxies()
			if err != nil {
				messages = append(messages, "PUBLIC ROLLBACK VERIFICATION FAILED: "+err.Error())
			} else if state, err := proxyState(verified); err != nil {
				messages = append(messages, "PUBLIC ROLLBACK VERIFICATION FAILED: "+err.Error())
			} else {
				for _, name := range journal.proxies {
					actual, present := state[name]
					old, existed := before[name]
					if present != existed || present && actual != old {
						messages = append(messages, "PUBLIC ROLLBACK VERIFICATION FAILED: "+name)
					}
				}
			}
		}
	}
	if len(journal.dnsAdded)+len(journal.dnsRemoved) > 0 {
		current, err := a.readLocalDNSRecords()
		if err != nil {
			return append(messages, "Cannot verify DNS rollback: "+err.Error())
		}
		for _, record := range journal.dnsAdded {
			if current[record.host][record.address] {
				if ok, out := a.runNDMC("no ip host " + record.host + " " + record.address); !ok {
					messages = append(messages, "DNS ROLLBACK FAILED: "+out)
				}
			}
		}
		for _, record := range journal.dnsRemoved {
			if !current[record.host][record.address] {
				if ok, out := a.runNDMC("ip host " + record.host + " " + record.address); !ok {
					messages = append(messages, "DNS ROLLBACK FAILED: "+out)
				}
			}
		}
		if ok, out := a.runNDMC("system configuration save"); !ok {
			messages = append(messages, "DNS ROLLBACK SAVE FAILED: "+out)
		}
		current, err = a.readLocalDNSRecords()
		if err != nil {
			return append(messages, "Cannot verify DNS rollback: "+err.Error())
		}
		for _, record := range journal.dnsAdded {
			if current[record.host][record.address] {
				messages = append(messages, "DNS ROLLBACK VERIFICATION FAILED: "+record.host)
			}
		}
		for _, record := range journal.dnsRemoved {
			if !current[record.host][record.address] {
				messages = append(messages, "DNS ROLLBACK VERIFICATION FAILED: "+record.host)
			}
		}
	}
	return messages
}
