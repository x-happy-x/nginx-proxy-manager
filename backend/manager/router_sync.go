package main

import (
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

var routerLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func validRouterName(v string) bool { return routerLabel.MatchString(v) }
func validRouterHost(v string) bool {
	if v == "" || len(v) > 253 || strings.TrimSpace(v) != v {
		return false
	}
	for _, label := range strings.Split(v, ".") {
		if !routerLabel.MatchString(label) {
			return false
		}
	}
	return true
}
func validRouterIP(v string) bool { return net.ParseIP(v) != nil }
func validRouterTarget(v string) bool {
	_, err := net.ParseMAC(v)
	return validRouterIP(v) || err == nil || validRouterHost(v)
}

func proxyFromPayload(item map[string]any) (ndnsProxy, error) {
	var p ndnsProxy
	body, err := json.Marshal(item)
	if err != nil {
		return p, err
	}
	// Port may arrive as a number from older API clients.
	upstream, _ := item["upstream"].(map[string]any)
	if upstream != nil {
		copy := map[string]any{}
		for k, v := range upstream {
			copy[k] = v
		}
		copy["port"] = mapString(upstream["port"])
		itemCopy := map[string]any{}
		for k, v := range item {
			itemCopy[k] = v
		}
		itemCopy["upstream"] = copy
		body, err = json.Marshal(itemCopy)
		if err != nil {
			return p, err
		}
	}
	if err = json.Unmarshal(body, &p); err != nil {
		return p, err
	}
	if p.Upstream.Proto == "" {
		p.Upstream.Proto = "http"
	}
	if p.Domain == "" {
		p.Domain = "ndns"
	}
	if p.SecurityLevel == "" {
		p.SecurityLevel = "public"
	}
	if !validRouterName(p.Name) || !validRouterTarget(p.Upstream.Target) || (p.Upstream.Proto != "http" && p.Upstream.Proto != "https") || schema.NormalizePort(p.Upstream.Port, 0) == 0 || !validRouterHost(p.Domain) || (p.SecurityLevel != "public" && p.SecurityLevel != "private" && p.SecurityLevel != "protected") {
		return p, fmt.Errorf("invalid KeenDNS proxy: check name, address, port and access level")
	}
	return p, nil
}
func proxyCommands(next ndnsProxy, previous *ndnsProxy) []string {
	base := "ip http proxy " + next.Name
	commands := []string{}
	if previous == nil {
		commands = append(commands, base)
	}
	if previous == nil || previous.Upstream != next.Upstream {
		commands = append(commands, fmt.Sprintf("%s upstream %s %s %s", base, next.Upstream.Proto, next.Upstream.Target, next.Upstream.Port))
	}
	if previous == nil || previous.Domain != next.Domain {
		commands = append(commands, base+" domain "+next.Domain)
	}
	if previous == nil || previous.SecurityLevel != next.SecurityLevel {
		commands = append(commands, base+" security-level "+next.SecurityLevel)
	}
	if previous == nil || previous.SSLRedirect != next.SSLRedirect {
		command := base + " ssl redirect"
		if !next.SSLRedirect {
			command = "no " + command
		}
		commands = append(commands, command)
	}
	return commands
}
func (a *app) currentProxies() ([]ndnsProxy, error) {
	ok, out := a.runNDMC("show running-config")
	if !ok {
		return nil, fmt.Errorf("read KeenDNS: %s", out)
	}
	return parseNDNSHTTPConfig(out).Proxies, nil
}
func (a *app) restoreProxy(old *ndnsProxy, name string) string {
	commands := []string{"no ip http proxy " + name}
	if old != nil {
		commands = proxyCommands(*old, nil)
	}
	errs := []string{}
	for _, command := range commands {
		if ok, out := a.runNDMC(command); !ok {
			errs = append(errs, strings.TrimSpace(out))
		}
	}
	if ok, out := a.runNDMC("system configuration save"); !ok {
		errs = append(errs, strings.TrimSpace(out))
	}
	if len(errs) > 0 {
		return "ROLLBACK FAILED: " + strings.Join(errs, "; ")
	}
	return "previous proxy restored"
}
func (a *app) upsertNDNS(item map[string]any, oldName string) (bool, string) {
	next, err := proxyFromPayload(item)
	if err != nil {
		return false, err.Error()
	}
	if oldName != "" && oldName != next.Name {
		return false, "rename requires creating the new proxy first and deleting the old one explicitly"
	}
	proxies, err := a.currentProxies()
	if err != nil {
		return false, err.Error()
	}
	var previous *ndnsProxy
	for _, p := range proxies {
		if p.Name == next.Name {
			copy := p
			previous = &copy
			break
		}
	}
	commands := proxyCommands(next, previous)
	if len(commands) == 0 {
		return true, "KeenDNS " + next.Name + ": unchanged"
	}
	for _, command := range commands {
		if ok, out := a.runNDMC(command); !ok {
			return false, out + "\n" + a.restoreProxy(previous, next.Name)
		}
	}
	if ok, out := a.runNDMC("system configuration save"); !ok {
		return false, out + "\n" + a.restoreProxy(previous, next.Name)
	}
	verified, err := a.currentProxies()
	if err == nil {
		for _, p := range verified {
			if p == next {
				return true, "KeenDNS " + next.Name + ": updated"
			}
		}
	}
	return false, "KeenDNS verification failed\n" + a.restoreProxy(previous, next.Name)
}
func (a *app) checkRoutes() (bool, string) {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return false, err.Error()
	}
	if err = schema.ResolveAutoPorts(&routes); err != nil {
		return false, err.Error()
	}
	previous, err := a.readAppliedOwnership()
	if err != nil {
		return false, err.Error()
	}
	if _, err := a.planManagedCleanup(previous, routes); err != nil {
		return false, "Managed ownership preflight: " + err.Error()
	}
	if err := a.preflightRouter(routes); err != nil {
		return false, err.Error()
	}
	// The generator's dry run never touches disk or router configuration.
	output, err := runCommand(a.genRoutesPath, "--config", a.routesPath(), "--dry-run")
	if err != nil {
		return false, output + "\n" + err.Error()
	}
	return true, output
}
