package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/golang/internal/schema"
)

var errEmptyPath = errors.New("empty_path")

func (a *app) runNDMC(args string) (bool, string) {
	cmd := exec.Command(a.ndmcBin, "-c", args)
	out, err := cmd.CombinedOutput()
	return err == nil, string(out)
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
	data, err := a.ndnsHTTPGet()
	if err != nil {
		return 0, err
	}
	used := map[int]struct{}{}
	for _, item := range data.Proxies {
		port := atoiDefault(item.Upstream.Port, 0)
		if port >= 1 && port <= 65535 {
			used[port] = struct{}{}
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
	name := mapString(item["name"])
	if name == "" {
		return false, "name_required"
	}
	upstream, _ := item["upstream"].(map[string]any)
	proto := mapString(upstream["proto"])
	if proto == "" {
		proto = "http"
	}
	target := mapString(upstream["target"])
	port := mapString(upstream["port"])
	domain := mapString(item["domain"])
	securityLevel := mapString(item["securityLevel"])
	sslRedirect := boolFromAny(item["sslRedirect"])
	oldName = strings.TrimSpace(oldName)
	if oldName != "" && oldName != name {
		_, _ = a.runNDMC("no ip http proxy " + oldName)
	}
	_, _ = a.runNDMC("no ip http proxy " + name)
	ok, out := a.runNDMC("ip http proxy " + name)
	if !ok {
		return false, out
	}
	if target != "" && port != "" {
		ok, out = a.runNDMC(fmt.Sprintf("ip http proxy %s upstream %s %s %s", name, proto, target, port))
		if !ok {
			return false, out
		}
	}
	if domain != "" {
		ok, out = a.runNDMC(fmt.Sprintf("ip http proxy %s domain %s", name, domain))
		if !ok {
			return false, out
		}
	}
	if sslRedirect {
		ok, out = a.runNDMC(fmt.Sprintf("ip http proxy %s ssl redirect", name))
		if !ok {
			return false, out
		}
	}
	if securityLevel != "" {
		ok, out = a.runNDMC(fmt.Sprintf("ip http proxy %s security-level %s", name, securityLevel))
		if !ok {
			return false, out
		}
	}
	return a.runNDMC("system configuration save")
}

func (a *app) ndnsProxyDelete(name string) (bool, string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return false, "name_required"
	}
	_, _ = a.runNDMC("no ip http proxy " + name)
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
	switch a.ipHostDeleteMode {
	case "no-host":
		return a.runNDMC("no ip host " + host)
	case "no-host-ip":
		return a.runNDMC("no ip host " + host + " " + address)
	default:
		return false, "unknown delete mode: " + a.ipHostDeleteMode
	}
}
