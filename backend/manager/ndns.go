package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

var errEmptyPath = errors.New("empty_path")

func (a *app) runNDMC(args string) (bool, string) {
	if a.ndmcRunner != nil {
		return a.ndmcRunner(args)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.ndmcBin, "-c", args)
	out, err := cmd.CombinedOutput()
	text := string(out)
	if ctx.Err() != nil {
		return false, "ndmc timeout: " + ctx.Err().Error()
	}
	if err != nil {
		return false, strings.TrimSpace(text + " " + err.Error())
	}
	lower := strings.ToLower(text)
	return !strings.Contains(lower, "error[") && !strings.Contains(lower, "command::base error") && !strings.Contains(lower, "unknown command"), text
}

func parseNDNSHTTPConfig(raw string) ndnsConfig {
	cfg := ndnsConfig{Proxies: []ndnsProxy{}}
	var cur *ndnsProxy
	seen := map[string]struct{}{}
	finalize := func() {
		if cur == nil {
			return
		}
		key := fmt.Sprintf("%s|%s|%s|%s|%s|%v|%s", cur.Name, cur.Upstream.Proto, cur.Upstream.Target, cur.Upstream.Port, cur.Domain, cur.SSLRedirect, cur.SecurityLevel)
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			cfg.Proxies = append(cfg.Proxies, *cur)
		}
		cur = nil
	}
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimRight(rawLine, "\n")
		stripped := strings.TrimSpace(line)
		if strings.HasPrefix(line, "ip http port ") {
			parts := strings.Fields(stripped)
			if len(parts) >= 4 {
				value := atoiDefault(parts[3], 0)
				if value > 0 {
					cfg.HTTP.Port = &value
				}
			}
			continue
		}
		if strings.HasPrefix(line, "ip http ssl port ") {
			parts := strings.Fields(stripped)
			if len(parts) >= 5 {
				value := atoiDefault(parts[4], 0)
				if value > 0 {
					cfg.HTTP.SSLPort = &value
				}
			}
			continue
		}
		if strings.HasPrefix(line, "ip http proxy ") {
			finalize()
			parts := strings.SplitN(stripped, " ", 4)
			if len(parts) < 4 {
				continue
			}
			cur = &ndnsProxy{Name: parts[3]}
			continue
		}
		if cur == nil {
			continue
		}
		if stripped == "!" {
			finalize()
			continue
		}
		parts := strings.Fields(stripped)
		if len(parts) >= 4 && parts[0] == "upstream" {
			cur.Upstream.Proto = parts[1]
			cur.Upstream.Target = parts[2]
			cur.Upstream.Port = parts[3]
			continue
		}
		if len(parts) >= 2 && parts[0] == "domain" {
			cur.Domain = parts[1]
			continue
		}
		if len(parts) >= 2 && parts[0] == "security-level" {
			cur.SecurityLevel = parts[1]
			continue
		}
		if len(parts) >= 2 && parts[0] == "ssl" && parts[1] == "redirect" {
			cur.SSLRedirect = true
		}
	}
	finalize()
	return cfg
}

func parseFirstPublicDomain(raw string) string {
	if raw == "" {
		return ""
	}
	re := regexp.MustCompile(`([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)`)
	found := []string{}
	for _, match := range re.FindAllString(raw, -1) {
		host := strings.Trim(strings.ToLower(match), ".")
		if strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".lan") || strings.HasSuffix(host, ".home.arpa") {
			continue
		}
		if host == "localhost" {
			continue
		}
		found = append(found, host)
	}
	for _, host := range found {
		if strings.Contains(host, "crazedns") || strings.Contains(host, "keenetic") || strings.Contains(host, "ndms") {
			return host
		}
	}
	if len(found) > 0 {
		return found[0]
	}
	return ""
}

func (a *app) ndnsDomainSuffixGet() string {
	if value := strings.TrimSpace(os.Getenv("KEENDNS_SUFFIX")); validRouterHost(value) {
		return value
	}
	if ok, out := a.runNDMC("show ndns"); ok {
		name, domain := "", ""
		for _, line := range strings.Split(out, "\n") {
			key, value, found := strings.Cut(strings.TrimSpace(line), ":")
			if !found {
				continue
			}
			value = strings.Trim(strings.TrimSpace(value), "\"")
			if key == "name" && name == "" {
				name = value
			}
			if key == "domain" && domain == "" {
				domain = value
			}
		}
		if validRouterName(name) && validRouterHost(domain) {
			return name + "." + domain
		}
	}
	for _, cmd := range []string{"show ndns", "show cloud", "show running-config"} {
		ok, out := a.runNDMC(cmd)
		if !ok {
			continue
		}
		if value := parseFirstPublicDomain(out); value != "" {
			return value
		}
	}
	return ""
}

func (a *app) ndnsHTTPGet() (ndnsConfig, error) {
	ok, out := a.runNDMC("show running-config")
	if !ok {
		return ndnsConfig{}, errors.New(strings.TrimSpace(out))
	}
	data := parseNDNSHTTPConfig(out)
	data.DomainSuffix = a.ndnsDomainSuffixGet()
	return data, nil
}

func randInt(min, max int) int {
	if max <= min {
		return min
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return min
	}
	value := int(b[0])<<8 + int(b[1])
	return min + (value % (max - min + 1))
}

func (a *app) ndnsSuggestPort(start, end int) (int, error) {
	if start < 1 || end > 65535 || end < start {
		return 0, errors.New("invalid port suggestion range")
	}
	proxies, err := a.currentProxies()
	if err != nil {
		return 0, err
	}
	used := map[int]struct{}{}
	reserve := func(port int) {
		if port >= 1 && port <= 65535 {
			used[port] = struct{}{}
		}
	}
	for _, item := range proxies {
		port := atoiDefault(item.Upstream.Port, 0)
		reserve(port)
	}
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return 0, fmt.Errorf("read routes before suggesting a port: %w", err)
	}
	if err := schema.ResolveAutoPorts(&routes); err != nil {
		return 0, err
	}
	reserve(schema.NormalizePort(routes.Globals.Ports.HTTP, 80))
	reserve(schema.NormalizePort(routes.Globals.Ports.HTTPS, 443))
	reserve(routes.Globals.UI.Port)
	_, uiPort := a.readUIBind()
	reserve(uiPort)
	for _, port := range append(append([]int{}, routes.Globals.Ports.HTTPExtra...), routes.Globals.Ports.HTTPSExtra...) {
		reserve(port)
	}
	for _, host := range routes.Hosts {
		for _, endpoint := range host.Endpoints {
			reserve(schema.NormalizePort(endpoint.Listen.Port, 0))
		}
	}
	listeners, err := runCommand("ss", "-H", "-lntu")
	if err != nil {
		listeners, err = runCommand("netstat", "-lntu")
	}
	if err != nil {
		return 0, errors.New("cannot inspect existing TCP/UDP listeners; refusing to suggest an unchecked port")
	}
	for _, line := range strings.Split(listeners, "\n") {
		for _, field := range strings.Fields(line) {
			// Handles IPv4, [IPv6]:port and BusyBox's unbracketed :::port.
			if colon := strings.LastIndex(field, ":"); colon >= 0 {
				if port, err := strconv.Atoi(field[colon+1:]); err == nil {
					reserve(port)
				}
			}
		}
	}
	for i := 0; i < 200; i++ {
		cand := randInt(start, end)
		if _, ok := used[cand]; !ok {
			return cand, nil
		}
	}
	for cand := start; cand <= end; cand++ {
		if _, ok := used[cand]; !ok {
			return cand, nil
		}
	}
	return 0, errors.New("no_free_port")
}

func (a *app) ndnsProxyApply(item map[string]any, oldName string) (bool, string) {
	return a.upsertNDNS(item, oldName)
}

func (a *app) ndnsProxyDelete(name string) (bool, string) {
	name = strings.TrimSpace(name)
	if !validRouterName(name) {
		return false, "invalid_proxy_name"
	}
	if ok, out := a.runNDMC("no ip http proxy " + name); !ok {
		return false, out
	}
	return a.runNDMC("system configuration save")
}

func hostNDNSPayload(hostItem schema.Host, listenIPs []string) map[string]any {
	if strings.TrimSpace(hostItem.Host) == "" {
		return nil
	}
	for _, ep := range hostItem.Endpoints {
		if ep.Behavior.NDNSProfile == "" && strings.ToLower(strings.TrimSpace(ep.Name)) != "ndns" {
			continue
		}
		port := schema.NormalizePort(ep.Listen.Port, 0)
		if port == 0 {
			continue
		}
		proto := strings.ToLower(strings.TrimSpace(ep.Listen.Protocol))
		if proto != "http" && proto != "https" {
			proto = "http"
		}
		name := strings.TrimSpace(ep.Behavior.NDNSName)
		if name == "" {
			if idx := strings.Index(hostItem.Host, "."); idx > 0 {
				name = hostItem.Host[:idx]
			} else {
				name = hostItem.Host
			}
		}
		target := strings.TrimSpace(ep.Behavior.NDNSTargetIP)
		if target == "" || target == "auto" {
			if len(listenIPs) > 0 {
				target = listenIPs[0]
			}
		}
		if name == "" || target == "" {
			continue
		}
		return map[string]any{
			"name": name,
			"upstream": map[string]any{
				"proto":  proto,
				"target": target,
				"port":   strconv.Itoa(port),
			},
			"domain":        valueOr(ep.Behavior.NDNSDomain, "ndns"),
			"securityLevel": valueOr(ep.Behavior.NDNSSecurityLevel, "public"),
			"sslRedirect":   ep.Behavior.NDNSSSLRedirect == nil || *ep.Behavior.NDNSSSLRedirect,
		}
	}
	return nil
}

func (a *app) syncNDNSFromRoutes(routes schema.Routes) (bool, string) {
	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(a.nginxListenIPs)
	}
	errorsOut := []string{}
	applied := 0
	for _, hostItem := range routes.Hosts {
		item := hostNDNSPayload(hostItem, listenIPs)
		if item == nil {
			continue
		}
		ok, out := a.ndnsProxyApply(item, "")
		if !ok {
			errorsOut = append(errorsOut, fmt.Sprintf("%v: %s", item["name"], strings.TrimSpace(out)))
		} else {
			applied++
		}
	}
	if len(errorsOut) > 0 {
		return false, strings.Join(errorsOut, "\n")
	}
	return true, fmt.Sprintf("ndns synced (%d)", applied)
}

func (a *app) listIPHosts() ([]response, error) {
	ok, out := a.runNDMC("show dns-proxy")
	if !ok {
		return nil, errors.New(strings.TrimSpace(out))
	}
	items := []response{}
	seen := map[string]struct{}{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "static_a = ") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 4 {
			continue
		}
		key := parts[2] + "|" + parts[3]
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		items = append(items, response{"host": parts[2], "address": parts[3]})
	}
	return items, nil
}

func (a *app) deleteIPHost(host, address string) (bool, string) {
	if !validRouterHost(host) || (address != "" && !validRouterIP(address)) {
		return false, "invalid_host_or_address"
	}
	switch a.ipHostDeleteMode {
	case "no-host":
		return a.runNDMC("no ip host " + host)
	case "no-host-ip":
		return a.runNDMC("no ip host " + host + " " + address)
	default:
		return false, "unknown delete mode: " + a.ipHostDeleteMode
	}
}
