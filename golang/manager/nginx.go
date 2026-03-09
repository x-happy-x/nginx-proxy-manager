package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func (a *app) nginxStatus() nginxStatus {
	status := nginxStatus{
		PIDs:            []string{},
		ConfigFiles:     []string{},
		Listeners:       []string{},
		ParsedListeners: []parsedListener{},
	}
	if out, err := runCommand("pidof", "nginx"); err == nil {
		for _, item := range strings.Fields(strings.TrimSpace(out)) {
			if _, err := strconv.Atoi(item); err == nil {
				status.PIDs = append(status.PIDs, item)
			}
		}
	}
	if len(status.PIDs) > 0 {
		status.Running = true
		status.PID = status.PIDs[0]
		for _, pid := range status.PIDs {
			body, err := os.ReadFile(filepath.Join("/proc", pid, "statm"))
			if err != nil {
				continue
			}
			parts := strings.Fields(string(body))
			if len(parts) > 1 {
				pages, _ := strconv.ParseInt(parts[1], 10, 64)
				status.RSSKB += pages * int64(os.Getpagesize()/1024)
			}
		}
	}
	if out, err := runCommand("nginx", "-v"); err == nil {
		status.Version = strings.TrimSpace(out)
	} else {
		status.Version = "nginx not found"
	}
	if out, err := runCommand("nginx", "-T"); err == nil {
		files := []string{}
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "# configuration file ") {
				path := strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "# configuration file ")), ":")
				files = append(files, path)
			}
		}
		status.ConfigFiles = uniqueStrings(files)
		sort.Strings(status.ConfigFiles)
		status.ParsedListeners = parseNginxTListeners(out)
	}
	if out, err := runCommand("ss", "-lntp"); err == nil {
		status.Listeners = filterNginxListeners(out, status.PIDs)
	} else if out, err := runCommand("netstat", "-lntp"); err == nil {
		status.Listeners = filterNginxListeners(out, status.PIDs)
	}
	return status
}

func filterNginxListeners(out string, pids []string) []string {
	lines := []string{}
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "nginx") {
			continue
		}
		if len(pids) > 0 {
			match := false
			for _, pid := range pids {
				if strings.Contains(line, "pid="+pid) || strings.Contains(line, "/"+pid) {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		lines = append(lines, line)
	}
	return lines
}

func parseListenAddress(value string) (string, int, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" || strings.HasPrefix(raw, "unix:") {
		return "", 0, false
	}
	if strings.HasPrefix(raw, "[") && strings.Contains(raw, "]") {
		idx := strings.Index(raw, "]")
		host := raw[1:idx]
		rest := raw[idx+1:]
		if strings.HasPrefix(rest, ":") {
			if port, err := strconv.Atoi(rest[1:]); err == nil {
				return host, port, true
			}
		}
		return host, 0, false
	}
	if strings.Contains(raw, ":") {
		host, portStr, ok := strings.Cut(raw, ":")
		if ok {
			if port, err := strconv.Atoi(portStr); err == nil {
				return host, port, true
			}
		}
	}
	if port, err := strconv.Atoi(raw); err == nil {
		return "", port, true
	}
	return raw, 0, false
}

func parseListenTokens(tokenStr string) *parsedListener {
	parts := strings.Fields(tokenStr)
	if len(parts) == 0 {
		return nil
	}
	host, port, ok := parseListenAddress(parts[0])
	if !ok {
		return nil
	}
	flags := append([]string{}, parts[1:]...)
	sort.Strings(flags)
	scheme := "http"
	for _, item := range flags {
		if item == "ssl" {
			scheme = "https"
			break
		}
	}
	if host == "" {
		host = "*"
	}
	return &parsedListener{IP: host, Port: port, Scheme: scheme, Flags: flags}
}

func parseNginxTListeners(text string) []parsedListener {
	items := []parsedListener{}
	seen := map[string]struct{}{}
	source := ""
	re := regexp.MustCompile(`^listen\s+(.+?);$`)
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "# configuration file ") {
			source = strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "# configuration file ")), ":")
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		match := re.FindStringSubmatch(line)
		if len(match) != 2 {
			continue
		}
		parsed := parseListenTokens(match[1])
		if parsed == nil {
			continue
		}
		parsed.Source = source
		key := fmt.Sprintf("%s|%d|%s|%s|%s", parsed.IP, parsed.Port, parsed.Scheme, strings.Join(parsed.Flags, ","), parsed.Source)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		items = append(items, *parsed)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Port != items[j].Port {
			return items[i].Port < items[j].Port
		}
		if items[i].IP != items[j].IP {
			return items[i].IP < items[j].IP
		}
		if items[i].Scheme != items[j].Scheme {
			return items[i].Scheme < items[j].Scheme
		}
		return items[i].Source < items[j].Source
	})
	return items
}

func (a *app) configCatalog() []configItem {
	items := []configItem{}
	candidates := []configItem{{ID: "routes_v21", Title: "Routes v2.1", Path: a.routesPath(), Type: "yaml", Editable: true}}
	status := a.nginxStatus()
	files := status.ConfigFiles
	if len(files) == 0 {
		files = []string{filepath.Join(a.nginxConfRoot, "nginx.conf")}
	}
	seen := map[string]struct{}{}
	for idx, path := range files {
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		itemType := "nginx"
		if strings.HasSuffix(path, ".types") {
			itemType = "text"
		}
		candidates = append(candidates, configItem{
			ID:       fmt.Sprintf("nginx_%d", idx),
			Title:    filepath.Base(path),
			Path:     path,
			Type:     itemType,
			Editable: true,
		})
	}
	for _, item := range candidates {
		info, err := os.Stat(item.Path)
		if err == nil {
			item.Exists = true
			item.Size = info.Size()
			item.MTime = info.ModTime().Unix()
			if item.Type == "nginx" {
				body, readErr := os.ReadFile(item.Path)
				if readErr == nil {
					item.Listens = parseNginxTListeners(string(body))
				}
			}
		}
		items = append(items, item)
	}
	return items
}

func (a *app) configByID(id string) *configItem {
	for _, item := range a.configCatalog() {
		if item.ID == id {
			copied := item
			return &copied
		}
	}
	return nil
}
