package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

func (a *app) listRouteFiles() response {
	active := a.routesPath()
	root := filepath.Dir(active)
	items := []string{}
	entries, err := osReadDir(root)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := strings.ToLower(entry.Name())
			if !strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml") {
				continue
			}
			items = append(items, filepath.Join(root, entry.Name()))
		}
	}
	sort.Strings(items)
	if !contains(items, active) {
		items = append([]string{active}, items...)
	}
	return response{"active": active, "dir": root, "items": items}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func (a *app) backupRoutesFile() (bool, string, string) {
	src := a.routesPath()
	body, err := osReadFile(src)
	if err != nil {
		return false, err.Error(), ""
	}
	name := filepath.Base(src)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	if ext == "" {
		ext = ".yml"
	}
	backupDir := filepath.Join(filepath.Dir(src), "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return false, err.Error(), ""
	}
	dst := filepath.Join(backupDir, fmt.Sprintf("%s.%s.bak%s", base, time.Now().Format("20060102-150405"), ext))
	if err := osWriteFile(dst, body, 0o644); err != nil {
		return false, err.Error(), ""
	}
	return true, "backup created", dst
}

func (a *app) applyRoutes() (bool, string) {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return false, err.Error()
	}
	if err := schema.ResolveAutoPorts(&routes); err != nil {
		return false, err.Error()
	}
	if err := schema.SaveRoutes(a.routesPath(), routes); err != nil {
		return false, err.Error()
	}
	out, err := runCommand(a.genRoutesPath, "--config", a.routesPath())
	return err == nil, out
}

type localDNSRecords map[string]map[string]bool
type localDNSChange struct{ host, address string }

func (a *app) readLocalDNSRecords() (localDNSRecords, error) {
	ok, raw := a.runNDMC("show running-config")
	if !ok {
		return nil, fmt.Errorf("read local DNS records: %s", raw)
	}
	records := localDNSRecords{}
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 3 || parts[0] != "ip" || parts[1] != "host" {
			continue
		}
		if len(parts) != 4 || !validRouterHost(parts[2]) || !validRouterIP(parts[3]) {
			return nil, fmt.Errorf("cannot safely parse an existing local DNS record")
		}
		name := strings.ToLower(parts[2])
		if records[name] == nil {
			records[name] = map[string]bool{}
		}
		records[name][net.ParseIP(parts[3]).String()] = true
	}
	return records, nil
}

func (a *app) planLocalDNS(routes schema.Routes) ([]localDNSChange, error) {
	if err := schema.ValidateRoutes(routes); err != nil {
		return nil, err
	}
	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(a.nginxListenIPs)
	}
	dnsIP := ""
	if len(listenIPs) > 0 {
		dnsIP = listenIPs[0]
	}
	existing, err := a.readLocalDNSRecords()
	if err != nil {
		return nil, err
	}
	planned := []localDNSChange{}
	wanted := map[string]string{}
	// Preflight the entire batch before making any change. Keenetic's `ip
	// host` can append addresses; it is not a replace operation.
	for _, item := range routes.Hosts {
		publish := item.DNS.Publish
		if !hasString(publish, "local") {
			continue
		}
		targetIP := item.DNS.LocalRecordIP
		if targetIP == "" || targetIP == "auto" {
			targetIP = dnsIP
		}
		if !validRouterHost(item.Host) || !validRouterIP(targetIP) {
			return nil, fmt.Errorf("DNS requires a valid proxy listener IP for %s", item.Host)
		}
		ip := net.ParseIP(targetIP)
		if ip.IsUnspecified() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
			return nil, fmt.Errorf("DNS requires a unicast proxy listener IP for %s", item.Host)
		}
		targetIP = ip.String()
		name := strings.ToLower(item.Host)
		if prior, found := wanted[name]; found && prior != targetIP {
			return nil, fmt.Errorf("Conflicting local DNS targets for %s; no records changed", name)
		} else if found {
			continue
		}
		wanted[name] = targetIP
		if len(existing[name]) > 0 {
			if len(existing[name]) != 1 || !existing[name][targetIP] {
				return nil, fmt.Errorf("Local DNS already maps %s elsewhere; no records changed", name)
			}
			continue
		}
		planned = append(planned, localDNSChange{name, targetIP})
	}
	return planned, nil
}

func (a *app) previewLocalDNS(routes schema.Routes) (bool, string) {
	planned, err := a.planLocalDNS(routes)
	if err != nil {
		return false, err.Error()
	}
	return true, fmt.Sprintf("local DNS: %d missing records to add; existing records preserved", len(planned))
}

func (a *app) syncLocalDNS(routes schema.Routes) (bool, string) {
	planned, err := a.planLocalDNS(routes)
	if err != nil {
		return false, err.Error()
	}
	changed := []localDNSChange{}
	rollback := func() string {
		if len(changed) == 0 {
			return "no DNS records were changed"
		}
		errorsOut := []string{}
		for i := len(changed) - 1; i >= 0; i-- {
			c := changed[i]
			if ok, out := a.runNDMC("no ip host " + c.host + " " + c.address); !ok {
				errorsOut = append(errorsOut, out)
			}
		}
		if ok, out := a.runNDMC("system configuration save"); !ok {
			errorsOut = append(errorsOut, "save rollback: "+out)
		}
		current, err := a.readLocalDNSRecords()
		if err != nil {
			errorsOut = append(errorsOut, err.Error())
		} else {
			for _, c := range changed {
				if current[c.host][c.address] {
					errorsOut = append(errorsOut, "rollback verification failed for "+c.host)
				}
			}
		}
		if len(errorsOut) > 0 {
			return "DNS ROLLBACK FAILED: " + strings.Join(errorsOut, "; ")
		}
		return "new DNS records removed and rollback saved"
	}
	for _, c := range planned {
		// Include uncertain/failed attempts: a timeout can happen after the
		// router accepted a command, and this exact pair was absent before.
		changed = append(changed, c)
		if ok, out := a.runNDMC("ip host " + c.host + " " + c.address); !ok {
			return false, c.host + ": " + strings.TrimSpace(out) + "\n" + rollback()
		}
	}
	if len(changed) > 0 {
		current, err := a.readLocalDNSRecords()
		if err != nil {
			return false, err.Error() + "\n" + rollback()
		}
		for _, c := range changed {
			if len(current[c.host]) != 1 || !current[c.host][c.address] {
				return false, "DNS verification failed for " + c.host + "\n" + rollback()
			}
		}
		if ok, out := a.runNDMC("system configuration save"); !ok {
			return false, out + "\n" + rollback()
		}
	}
	return true, fmt.Sprintf("local DNS: %d records updated", len(changed))
}

func hasString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func (a *app) readUIBind() (string, int) {
	host := strings.TrimSpace(getenv("LITE_UI_HOST", ""))
	portRaw := strings.TrimSpace(getenv("LITE_UI_PORT", ""))
	if host == "" || portRaw == "" {
		routes, err := schema.LoadRoutes(a.routesPath())
		if err == nil {
			if host == "" {
				host = strings.TrimSpace(routes.Globals.UI.Host)
			}
			if portRaw == "" && routes.Globals.UI.Port != 0 {
				portRaw = fmt.Sprint(routes.Globals.UI.Port)
			}
		}
	}
	if host == "" {
		host = "0.0.0.0"
	}
	port := atoiDefault(portRaw, 8080)
	return host, port
}
