package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"gopkg.in/yaml.v3"
)

// Synchronization is deliberately opt-in: reloading Mihomo affects the router's
// main traffic proxy, so an unconfigured installation must never call its API.
var mihomoSyncMu sync.Mutex

type mihomoDNSChange struct {
	Host    string `json:"host"`
	Address string `json:"address"`
}

type mihomoDNSPlan struct {
	Enabled    bool              `json:"enabled"`
	Mode       string            `json:"mode,omitempty"`
	ConfigPath string            `json:"config_path,omitempty"`
	Changes    []mihomoDNSChange `json:"changes"`
	Message    string            `json:"message"`
}

type mihomoSettings struct {
	config, binary, controller, home, secret, mode, hostsPath string
}

func mihomoEnvironment() (mihomoSettings, bool, error) {
	s := mihomoSettings{
		config: strings.TrimSpace(os.Getenv("MIHOMO_CONFIG")), binary: strings.TrimSpace(os.Getenv("MIHOMO_BINARY")),
		controller: strings.TrimSpace(os.Getenv("MIHOMO_CONTROLLER")), home: strings.TrimSpace(os.Getenv("MIHOMO_HOME")),
		secret: os.Getenv("MIHOMO_SECRET"),
		mode:   strings.TrimSpace(os.Getenv("MIHOMO_DNS_MODE")), hostsPath: strings.TrimSpace(os.Getenv("MIHOMO_HOSTS_PATH")),
	}
	if s.mode == "" && s.config == "" && s.binary == "" && s.controller == "" && s.hostsPath == "" {
		return s, false, nil
	}
	if s.mode == "system-hosts" {
		if !filepath.IsAbs(s.config) {
			return s, false, fmt.Errorf("system-hosts mode requires an absolute MIHOMO_CONFIG for read-only DNS verification")
		}
		if s.hostsPath == "" {
			s.hostsPath = "/etc/hosts"
		}
		if !filepath.IsAbs(s.hostsPath) {
			return s, false, fmt.Errorf("MIHOMO_HOSTS_PATH must be an absolute path")
		}
		return s, true, nil
	}
	if s.mode != "config-reload" {
		return s, false, fmt.Errorf("set MIHOMO_DNS_MODE=system-hosts for DNS synchronization without reloading Mihomo")
	}
	if s.config == "" || s.binary == "" || s.controller == "" {
		return s, false, fmt.Errorf("Mihomo integration requires MIHOMO_CONFIG, MIHOMO_BINARY and MIHOMO_CONTROLLER")
	}
	if !filepath.IsAbs(s.config) || !filepath.IsAbs(s.binary) {
		return s, false, fmt.Errorf("Mihomo configuration and executable paths must be absolute")
	}
	if s.home == "" {
		// Keep the original configuration directory: config.yaml may be a
		// symlink to profiles/default.yaml, while providers live next to it.
		s.home = filepath.Dir(s.config)
	}
	if !filepath.IsAbs(s.home) {
		return s, false, fmt.Errorf("MIHOMO_HOME must be an absolute directory")
	}
	u, err := url.Parse(s.controller)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return s, false, fmt.Errorf("MIHOMO_CONTROLLER must be a plain local HTTP(S) origin")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return s, false, fmt.Errorf("MIHOMO_CONTROLLER must use a literal loopback address")
	}
	s.controller = strings.TrimRight(s.controller, "/")
	return s, true, nil
}

func (a *app) previewMihomoDNS(routes schema.Routes) (mihomoDNSPlan, error) {
	s, enabled, err := mihomoEnvironment()
	plan := mihomoDNSPlan{Enabled: enabled, Mode: s.mode, Changes: []mihomoDNSChange{}, Message: "Mihomo DNS synchronization is disabled; configure system-hosts mode to publish local hosts without reloading Mihomo"}
	if err != nil || !enabled {
		return plan, err
	}
	plan.ConfigPath = s.config
	if s.mode == "system-hosts" {
		_, changes, err := a.mihomoSystemHostsCandidate(s, routes)
		plan.Changes = changes
		plan.Message = "Update only the HomeNet block in system hosts; Mihomo reads it within five seconds without reload"
		return plan, err
	}
	body, err := os.ReadFile(s.config)
	if err != nil {
		return plan, fmt.Errorf("read Mihomo configuration: %w", err)
	}
	_, changes, _, err := a.mihomoHostsCandidate(body, routes)
	if err != nil {
		return plan, err
	}
	plan.Changes = changes
	plan.Message = "Mihomo hosts are already synchronized"
	if len(changes) > 0 {
		plan.Message = fmt.Sprintf("Add %d exact hosts; preserve all existing Mihomo routes, providers and listeners", len(changes))
	}
	return plan, nil
}

func mihomoYAMLField(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func mihomoYAMLHostField(node *yaml.Node, name string) *yaml.Node {
	for i := 0; node != nil && i+1 < len(node.Content); i += 2 {
		if strings.EqualFold(strings.TrimSuffix(node.Content[i].Value, "."), name) {
			return node.Content[i+1]
		}
	}
	return nil
}

func (a *app) mihomoHostsCandidate(body []byte, routes schema.Routes) ([]byte, []mihomoDNSChange, string, error) {
	changes := []mihomoDNSChange{}
	var doc yaml.Node
	decoder := yaml.NewDecoder(bytes.NewReader(body))
	if decoder.Decode(&doc) != nil || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, changes, "", fmt.Errorf("Mihomo configuration must be a valid YAML mapping")
	}
	var extra yaml.Node
	if decoder.Decode(&extra) != io.EOF {
		return nil, changes, "", fmt.Errorf("Mihomo configuration must contain exactly one YAML document")
	}
	var checked map[string]any
	if doc.Decode(&checked) != nil {
		return nil, changes, "", fmt.Errorf("Mihomo configuration contains invalid or duplicate YAML fields")
	}
	root := doc.Content[0]
	dns := mihomoYAMLField(root, "dns")
	if dns == nil || dns.Kind != yaml.MappingNode {
		return nil, changes, "", fmt.Errorf("Mihomo DNS must be configured before host synchronization")
	}
	for _, field := range []string{"enable", "use-hosts"} {
		n := mihomoYAMLField(dns, field)
		if n == nil && field == "use-hosts" {
			continue // Mihomo defaults use-hosts to true.
		}
		var enabled bool
		if n == nil || n.Decode(&enabled) != nil || !enabled {
			return nil, changes, "", fmt.Errorf("Mihomo dns.%s must be true; the manager will not change global DNS settings", field)
		}
	}
	secret := ""
	if n := mihomoYAMLField(root, "secret"); n != nil {
		if n.Kind != yaml.ScalarNode {
			return nil, changes, "", fmt.Errorf("Mihomo secret must be a scalar")
		}
		secret = n.Value
	}
	hosts := mihomoYAMLField(root, "hosts")
	if hosts == nil {
		hosts = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "hosts"}, hosts)
	}
	if hosts.Kind != yaml.MappingNode {
		return nil, changes, "", fmt.Errorf("Mihomo hosts must be a mapping; aliases and scalar hosts cannot be modified safely")
	}
	listenIPs := routes.Globals.ListenIPs
	if len(listenIPs) == 0 {
		listenIPs = schema.ParseListenIPs(a.nginxListenIPs)
	}
	desired := map[string]string{}
	for _, host := range routes.Hosts {
		if !hasString(host.DNS.Publish, "local") {
			continue
		}
		name := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host.Host), "."))
		if !schema.ValidHostname(name) || strings.ContainsAny(name, "*+") {
			return nil, changes, "", fmt.Errorf("Mihomo synchronization requires exact domain names")
		}
		address := host.DNS.LocalRecordIP
		if address == "" || address == "auto" {
			if len(listenIPs) == 0 {
				return nil, changes, "", fmt.Errorf("no proxy listen IP configured for %s", name)
			}
			address = listenIPs[0]
		}
		ip := net.ParseIP(address)
		if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
			return nil, changes, "", fmt.Errorf("invalid local proxy IP for %s", name)
		}
		address = ip.String()
		if existing, ok := desired[name]; ok && existing != address {
			return nil, changes, "", fmt.Errorf("conflicting local proxy IPs for %s", name)
		}
		desired[name] = address
	}
	names := make([]string, 0, len(desired))
	for name := range desired {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		address := desired[name]
		existing := mihomoYAMLHostField(hosts, name)
		if existing != nil {
			if existing.Kind == yaml.ScalarNode && existing.Value == address {
				continue
			}
			if existing.Kind == yaml.SequenceNode && len(existing.Content) == 1 && existing.Content[0].Value == address {
				continue
			}
			return nil, changes, "", fmt.Errorf("Mihomo already has a different host entry for %s; refusing to overwrite it", name)
		}
		hosts.Content = append(hosts.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: address})
		changes = append(changes, mihomoDNSChange{Host: name, Address: address})
	}
	if len(changes) == 0 {
		return body, changes, secret, nil
	}
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&doc); err != nil {
		return nil, changes, "", fmt.Errorf("encode Mihomo hosts configuration")
	}
	return out.Bytes(), changes, secret, nil
}

func mihomoReload(s mihomoSettings) error {
	body, _ := json.Marshal(map[string]string{"path": s.config})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.controller+"/configs?force=false", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create local Mihomo reload request")
	}
	req.Header.Set("Content-Type", "application/json")
	if s.secret != "" {
		req.Header.Set("Authorization", "Bearer "+s.secret)
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("local Mihomo controller reload failed or timed out")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("local Mihomo controller returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func mihomoPrivateFile(dir, pattern string, body []byte) (string, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	name := f.Name()
	if err = f.Chmod(0o600); err == nil {
		_, err = f.Write(body)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

// syncMihomoDNS never removes pre-existing user hosts. System-hosts mode may
// prune stale entries only inside the manager's explicitly marked block.
func (a *app) syncMihomoDNS(routes schema.Routes) (bool, string) {
	mihomoSyncMu.Lock()
	defer mihomoSyncMu.Unlock()
	s, enabled, err := mihomoEnvironment()
	if err != nil {
		return false, err.Error()
	}
	if !enabled {
		return true, "Mihomo DNS synchronization disabled (MIHOMO_DNS_MODE is unset)"
	}
	if s.mode == "system-hosts" {
		return a.applyMihomoSystemHosts(s, routes)
	}
	return a.applyMihomoHosts(s, routes, mihomoValidateCandidate, mihomoReload)
}

const mihomoHostsBegin = "# BEGIN HOMENET MANAGED HOSTS"
const mihomoHostsEnd = "# END HOMENET MANAGED HOSTS"

// splitMihomoHosts preserves every byte outside the manager-owned block.
func splitMihomoHosts(body []byte) (prefix, suffix []byte, err error) {
	start, end, offset := -1, -1, 0
	for _, line := range bytes.SplitAfter(body, []byte("\n")) {
		switch strings.TrimSpace(string(line)) {
		case mihomoHostsBegin:
			if start >= 0 || end >= 0 {
				return nil, nil, fmt.Errorf("system hosts contains duplicate HomeNet block markers")
			}
			start = offset
		case mihomoHostsEnd:
			if start < 0 || end >= 0 {
				return nil, nil, fmt.Errorf("system hosts contains invalid HomeNet block markers")
			}
			end = offset + len(line)
		}
		offset += len(line)
	}
	if start < 0 {
		return body, nil, nil
	}
	if end < 0 {
		return nil, nil, fmt.Errorf("system hosts contains an unterminated HomeNet block")
	}
	return body[:start], body[end:], nil
}

func (a *app) mihomoSystemHostsCandidate(s mihomoSettings, routes schema.Routes) ([]byte, []mihomoDNSChange, error) {
	configuration, err := os.ReadFile(s.config)
	if err != nil {
		return nil, nil, fmt.Errorf("read Mihomo DNS settings: %w", err)
	}
	// Reuse exact-domain/IP validation, and ensure a configured hosts entry
	// cannot silently override the intended system-hosts mapping.
	_, desired, _, err := a.mihomoHostsCandidate(configuration, routes)
	if err != nil {
		return nil, nil, err
	}
	var doc yaml.Node
	_ = yaml.Unmarshal(configuration, &doc)
	root := doc.Content[0]
	if n := mihomoYAMLField(mihomoYAMLField(root, "dns"), "use-system-hosts"); n != nil {
		var enabled bool
		if n.Decode(&enabled) != nil || !enabled {
			return nil, nil, fmt.Errorf("Mihomo dns.use-system-hosts must be true; no global setting will be changed")
		}
	}
	// Existing identical YAML hosts already win over system hosts. Only the
	// missing entries belong in our block, leaving the user's entries alone.
	configuredHosts := mihomoYAMLField(root, "hosts")
	if configuredHosts != nil {
		for i := 0; i+1 < len(configuredHosts.Content); i += 2 {
			pattern := strings.ToLower(configuredHosts.Content[i].Value)
			value := configuredHosts.Content[i+1]
			for _, item := range desired {
				suffix := strings.TrimLeft(pattern, "+*.")
				isWildcard := strings.HasPrefix(pattern, "*.") || strings.HasPrefix(pattern, "+.") || strings.HasPrefix(pattern, ".")
				matches := item.Host == suffix || strings.HasSuffix(item.Host, "."+suffix)
				if isWildcard && matches && (value.Kind != yaml.ScalarNode || value.Value != item.Address) {
					return nil, nil, fmt.Errorf("Mihomo wildcard %s shadows system host %s", pattern, item.Host)
				}
			}
		}
	}
	body, err := os.ReadFile(s.hostsPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read system hosts: %w", err)
	}
	prefix, suffix, err := splitMihomoHosts(body)
	if err != nil {
		return nil, nil, err
	}
	wanted := map[string]string{}
	for _, item := range desired {
		wanted[item.Host] = item.Address
	}
	foreign := append(append([]byte{}, prefix...), suffix...)
	for _, line := range strings.Split(string(foreign), "\n") {
		fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(fields) < 2 {
			continue
		}
		for _, host := range fields[1:] {
			host = strings.ToLower(strings.TrimSuffix(host, "."))
			if address, exists := wanted[host]; exists {
				ip := net.ParseIP(fields[0])
				if ip == nil || ip.String() != address {
					return nil, nil, fmt.Errorf("system hosts already maps %s elsewhere; refusing to change a foreign entry", host)
				}
			}
		}
	}
	var candidate bytes.Buffer
	candidate.Write(prefix)
	if len(desired) > 0 {
		if len(prefix) > 0 && prefix[len(prefix)-1] != '\n' {
			candidate.WriteByte('\n')
		}
		candidate.WriteString(mihomoHostsBegin + "\n")
		for _, item := range desired {
			fmt.Fprintf(&candidate, "%s\t%s\n", item.Address, item.Host)
		}
		candidate.WriteString(mihomoHostsEnd + "\n")
	}
	candidate.Write(suffix)
	if bytes.Equal(candidate.Bytes(), body) {
		return body, []mihomoDNSChange{}, nil
	}
	return candidate.Bytes(), desired, nil
}

func (a *app) applyMihomoSystemHosts(s mihomoSettings, routes schema.Routes) (bool, string) {
	target, err := filepath.EvalSymlinks(s.hostsPath)
	if err != nil {
		return false, fmt.Sprintf("resolve system hosts: %v", err)
	}
	original, err := os.ReadFile(target)
	if err != nil {
		return false, fmt.Sprintf("read system hosts: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return false, "system hosts target must be a regular file"
	}
	candidate, _, err := a.mihomoSystemHostsCandidate(s, routes)
	if err != nil {
		return false, err.Error()
	}
	if bytes.Equal(candidate, original) {
		return true, "System hosts already synchronized; Mihomo was not reloaded"
	}
	staged, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-hosts-staged-*", candidate)
	if err != nil {
		return false, fmt.Sprintf("stage system hosts: %v", err)
	}
	defer os.Remove(staged)
	// System hosts must retain its original readability for other processes.
	if err := os.Chmod(staged, info.Mode().Perm()); err != nil {
		return false, fmt.Sprintf("preserve system hosts permissions: %v", err)
	}
	currentTarget, err := filepath.EvalSymlinks(s.hostsPath)
	if err != nil || currentTarget != target {
		return false, "system hosts target changed; retry the preview"
	}
	current, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(current, original) {
		return false, "system hosts changed concurrently; retry the preview"
	}
	backup, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-hosts-backup-*", original)
	if err != nil {
		return false, fmt.Sprintf("back up system hosts: %v", err)
	}
	if err := os.Rename(staged, target); err != nil {
		return false, fmt.Sprintf("replace system hosts: %v; backup: %s", err, backup)
	}
	return true, fmt.Sprintf("HomeNet system hosts updated; Mihomo reads changes within five seconds without reload; backup: %s", backup)
}

func mihomoValidateCandidate(s mihomoSettings, staged string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.binary, "-t", "-d", s.home, "-f", staged)
	cmd.Dir = s.home
	// Never include validator output: proxy URLs and credentials may appear there.
	if cmd.Run() != nil {
		return fmt.Errorf("Mihomo rejected the staged configuration; active configuration was preserved")
	}
	return nil
}

func (a *app) applyMihomoHosts(s mihomoSettings, routes schema.Routes, validate func(mihomoSettings, string) error, reload func(mihomoSettings) error) (bool, string) {
	target, err := filepath.EvalSymlinks(s.config)
	if err != nil {
		return false, fmt.Sprintf("resolve Mihomo configuration: %v", err)
	}
	original, err := os.ReadFile(target)
	if err != nil {
		return false, fmt.Sprintf("read Mihomo configuration: %v", err)
	}
	candidate, changes, secret, err := a.mihomoHostsCandidate(original, routes)
	if err != nil {
		return false, err.Error()
	}
	if len(changes) == 0 {
		return true, "Mihomo hosts are already synchronized; no reload needed"
	}
	if s.secret == "" {
		s.secret = secret
	}
	staged, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-staged-*.yaml", candidate)
	if err != nil {
		return false, fmt.Sprintf("stage Mihomo hosts: %v", err)
	}
	defer os.Remove(staged)
	if err := validate(s, staged); err != nil {
		return false, err.Error()
	}
	currentTarget, err := filepath.EvalSymlinks(s.config)
	if err != nil || currentTarget != target {
		return false, "Mihomo active profile changed during validation; retry the preview"
	}
	current, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(current, original) {
		return false, "Mihomo configuration changed during validation; retry the preview"
	}
	backup, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-backup-*.yaml", original)
	if err != nil {
		return false, fmt.Sprintf("back up Mihomo configuration: %v", err)
	}
	if err := os.Rename(staged, target); err != nil {
		return false, fmt.Sprintf("replace Mihomo configuration: %v; backup: %s", err, backup)
	}
	if err := reload(s); err != nil {
		// Do not overwrite a concurrent third-party edit during recovery.
		current, readErr := os.ReadFile(target)
		if readErr != nil || !bytes.Equal(current, candidate) {
			return false, fmt.Sprintf("%v; configuration changed concurrently; manual recovery required using %s", err, backup)
		}
		restore, restoreErr := mihomoPrivateFile(filepath.Dir(target), ".homenet-restore-*.yaml", original)
		if restoreErr == nil {
			restoreErr = os.Rename(restore, target)
			_ = os.Remove(restore)
		}
		if restoreErr != nil {
			return false, fmt.Sprintf("%v; failed to restore configuration; recovery backup: %s", err, backup)
		}
		if rollbackErr := reload(s); rollbackErr != nil {
			return false, fmt.Sprintf("%v; original file restored but controller rollback failed; recovery backup: %s", err, backup)
		}
		return false, fmt.Sprintf("%v; original file and runtime restored; backup: %s", err, backup)
	}
	return true, fmt.Sprintf("Added %d Mihomo DNS hosts; backup: %s", len(changes), backup)
}
