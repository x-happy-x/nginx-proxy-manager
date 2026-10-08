// Package integration defines the versioned boundary between HomeNet and its packages.
// It deliberately has no dependency on nginx, routes, or VPN configuration.
package integration

import (
	"fmt"
	"net"
	"net/url"
	"path"
	"regexp"
	"strings"
)

const Protocol = 1

var identifier = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
var version = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type Manifest struct {
	Schema          int          `json:"schema"`
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Description     string       `json:"description"`
	Version         string       `json:"version"`
	Arch            string       `json:"arch"`
	CoreAPI         int          `json:"core_api"`
	UIAPI           int          `json:"ui_api"`
	Dependencies    []Dependency `json:"dependencies,omitempty"`
	Capabilities    []string     `json:"capabilities,omitempty"`
	UI              UI           `json:"ui"`
	Backend         Backend      `json:"backend"`
	DataSchema      int          `json:"data_schema"`
	DataDirectories []string     `json:"data_directories"`
	Permissions     []string     `json:"permissions,omitempty"`
	Connections     []string     `json:"connections,omitempty"`
	Package         string       `json:"package"`
}
type Dependency struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Optional bool   `json:"optional,omitempty"`
}
type UI struct {
	Entry string   `json:"entry"`
	CSS   []string `json:"css,omitempty"`
	Pages []Page   `json:"pages"`
}
type Page struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Aliases []string `json:"aliases,omitempty"`
}
type Backend struct {
	Endpoint string   `json:"endpoint"`
	Health   string   `json:"health"`
	Paths    []string `json:"paths"`
	Service  string   `json:"service"`
}

func ValidID(s string) bool { return identifier.MatchString(s) }
func asset(s string) bool {
	return s != "" && s != "." && !strings.ContainsAny(s, `\?#:%`) && !strings.HasPrefix(s, "/") && path.Clean(s) == s && !strings.HasPrefix(s, "../")
}
func (m Manifest) Validate(arch string) error {
	if m.Schema != Protocol || m.CoreAPI != Protocol || m.UIAPI != Protocol {
		return fmt.Errorf("incompatible integration protocol")
	}
	if !ValidID(m.ID) || !ValidID(m.Package) || !version.MatchString(m.Version) || strings.TrimSpace(m.Name) == "" {
		return fmt.Errorf("invalid integration identity")
	}
	if m.ID == "core" || m.ID == "dms" || m.ID == "account" {
		return fmt.Errorf("reserved baseline component")
	}
	if m.Arch != arch {
		return fmt.Errorf("package architecture %q does not match %q", m.Arch, arch)
	}
	if !asset(m.UI.Entry) {
		return fmt.Errorf("invalid UI entry")
	}
	for _, p := range m.UI.CSS {
		if !asset(p) {
			return fmt.Errorf("invalid CSS path")
		}
	}
	u, err := url.Parse(m.Backend.Endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("invalid backend endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || u.Port() == "" {
		return fmt.Errorf("backend must use an explicit loopback address and port")
	}
	if !strings.HasPrefix(m.Backend.Service, "S") || strings.ContainsAny(m.Backend.Service, `/\ .`) {
		return fmt.Errorf("invalid integration service")
	}
	if !apiPath(m.Backend.Health) || len(m.Backend.Paths) == 0 {
		return fmt.Errorf("missing backend API allowlist")
	}
	for _, p := range m.Backend.Paths {
		if !apiPath(p) {
			return fmt.Errorf("invalid API path")
		}
	}
	seen := map[string]bool{}
	for _, p := range m.UI.Pages {
		for _, id := range append([]string{p.ID}, p.Aliases...) {
			if id == "overview" || id == "integrations" || id == "system" || id == "access" {
				return fmt.Errorf("reserved Core page")
			}
			if !ValidID(id) || seen[id] {
				return fmt.Errorf("invalid or duplicate page %q", id)
			}
			seen[id] = true
		}
	}
	seen = map[string]bool{}
	for _, d := range m.Dependencies {
		if !ValidID(d.ID) || d.ID == m.ID || seen[d.ID] || !version.MatchString(d.Version) {
			return fmt.Errorf("invalid dependency")
		}
		seen[d.ID] = true
	}
	if m.DataSchema < 1 {
		return fmt.Errorf("invalid data schema")
	}
	for _, d := range m.DataDirectories {
		if !strings.HasPrefix(d, "/") || path.Clean(d) != d || strings.ContainsAny(d, `\`) || d == "/" {
			return fmt.Errorf("invalid data directory")
		}
	}
	return nil
}
func apiPath(p string) bool {
	return strings.HasPrefix(p, "/") && path.Clean(p) == strings.TrimSuffix(p, "/") && !strings.ContainsAny(p, `\?#%`) && p != "/"
}

// Allows uses segment boundaries; /api/route must never authorize /api/routes-delete.
func (m Manifest) Allows(p string) bool {
	if !apiPath(p) {
		return false
	}
	for _, allowed := range m.Backend.Paths {
		if p == allowed || (strings.HasSuffix(allowed, "/") && strings.HasPrefix(p, allowed)) {
			return true
		}
	}
	return false
}

// ValidateSet checks the candidate as a whole before changing a running registry.
// Exact dependency versions make release sets reproducible, including consumers.
func ValidateSet(items []Manifest, arch string) error {
	byID := map[string]Manifest{}
	routes := map[string]string{}
	endpoints := map[string]bool{}
	for _, m := range items {
		if err := m.Validate(arch); err != nil {
			return fmt.Errorf("%s: %w", m.ID, err)
		}
		if _, ok := byID[m.ID]; ok {
			return fmt.Errorf("duplicate integration %s", m.ID)
		}
		byID[m.ID] = m
		if endpoints[m.Backend.Endpoint] {
			return fmt.Errorf("duplicate worker endpoint")
		}
		endpoints[m.Backend.Endpoint] = true
		for _, p := range m.UI.Pages {
			for _, id := range append([]string{p.ID}, p.Aliases...) {
				if owner, ok := routes[id]; ok {
					return fmt.Errorf("page %s owned by both %s and %s", id, owner, m.ID)
				}
				routes[id] = m.ID
			}
		}
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if visiting[id] {
			return fmt.Errorf("dependency cycle at %s", id)
		}
		if done[id] {
			return nil
		}
		visiting[id] = true
		for _, d := range byID[id].Dependencies {
			other, exists := byID[d.ID]
			if !exists {
				if d.Optional {
					continue
				}
				return fmt.Errorf("%s requires %s", id, d.ID)
			}
			if d.Version != other.Version {
				return fmt.Errorf("%s requires %s version %s", id, d.ID, d.Version)
			}
			if err := visit(d.ID); err != nil {
				return err
			}
		}
		visiting[id] = false
		done[id] = true
		return nil
	}
	for id := range byID {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}
