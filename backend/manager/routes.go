package main

import (
	"fmt"
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
	out, err := runCommand(a.genRoutesPath, "--config", a.routesPath())
	return err == nil, out
}

func (a *app) syncLocalDNS(routes schema.Routes) (bool, string) {
	apps := map[string]schema.App{}
	for _, item := range routes.Apps {
		if item.ID != "" {
			apps[item.ID] = item
		}
	}
	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(a.nginxListenIPs)
	}
	dnsIP := ""
	if len(listenIPs) > 0 {
		dnsIP = listenIPs[0]
	}
	errorsOut := []string{}
	for _, item := range routes.Hosts {
		publish := item.DNS.Publish
		if !hasString(publish, "local") {
			continue
		}
		appItem, ok := apps[item.AppID]
		if !ok && dnsIP == "" {
			continue
		}
		targetIP := item.DNS.LocalRecordIP
		if targetIP == "" || targetIP == "auto" {
			targetIP = dnsIP
		}
		if targetIP == "" {
			targetIP = appItem.Upstream.Address
		}
		if strings.TrimSpace(item.Host) == "" || strings.TrimSpace(targetIP) == "" {
			continue
		}
		_, _ = a.deleteIPHost(item.Host, targetIP)
		okAdd, out := a.runNDMC("ip host " + item.Host + " " + targetIP)
		if !okAdd {
			errorsOut = append(errorsOut, item.Host+": "+strings.TrimSpace(out))
		}
	}
	if len(errorsOut) > 0 {
		return false, strings.Join(errorsOut, "\n")
	}
	return true, "local DNS synced"
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
