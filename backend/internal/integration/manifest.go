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

// UIProtocol is the newest UI contract Core understands. ui_api 2 adds home
// widgets and summaries; a ui_api 1 module keeps working with its pages only.
const UIProtocol = 2

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
	Entry   string   `json:"entry"`
	CSS     []string `json:"css,omitempty"`
	Pages   []Page   `json:"pages"`
	Widgets []Widget `json:"widgets,omitempty"`
	Summary *Summary `json:"summary,omitempty"`
}

// Widget is a card a module offers for Core's home page (docs/modular-homenet/widgets.md).
// Data is fetched by Core through the module's own allowlisted paths.
type Widget struct {
	ID      string         `json:"id"`
	Title   string         `json:"title"`
	Kind    string         `json:"kind"`
	Sizes   []string       `json:"sizes"`
	Data    string         `json:"data,omitempty"`
	Refresh int            `json:"refresh,omitempty"`
	Modes   []string       `json:"modes"`
	Default map[string]int `json:"default,omitempty"`
	Page    string         `json:"page,omitempty"`
}

// Summary points to the module's attention and task lists, merged by Core.
type Summary struct {
	Attention string `json:"attention,omitempty"`
	Tasks     string `json:"tasks,omitempty"`
}

var WidgetKinds = map[string]bool{"stat": true, "status": true, "list": true, "progress": true, "series": true, "bars": true, "custom": true}
var WidgetSizes = map[string]bool{"s": true, "m": true, "l": true}
var HomeModes = map[string]bool{"simple": true, "pro": true}
var widgetID = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

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
	if m.Schema != Protocol || m.CoreAPI != Protocol || m.UIAPI < 1 || m.UIAPI > UIProtocol {
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
	if err := m.validateWidgets(seen); err != nil {
		return err
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
func (m Manifest) validateWidgets(pages map[string]bool) error {
	if m.UIAPI < 2 {
		if len(m.UI.Widgets) > 0 || m.UI.Summary != nil {
			return fmt.Errorf("widgets require ui_api 2")
		}
		return nil
	}
	if len(m.UI.Widgets) > 16 {
		return fmt.Errorf("too many widgets")
	}
	seen := map[string]bool{}
	for _, w := range m.UI.Widgets {
		if !widgetID.MatchString(w.ID) || seen[w.ID] {
			return fmt.Errorf("invalid or duplicate widget %q", w.ID)
		}
		seen[w.ID] = true
		if strings.TrimSpace(w.Title) == "" || len([]rune(w.Title)) > 48 {
			return fmt.Errorf("widget %s: invalid title", w.ID)
		}
		if !WidgetKinds[w.Kind] {
			return fmt.Errorf("widget %s: unknown kind", w.ID)
		}
		if len(w.Sizes) == 0 || len(w.Sizes) > 3 || len(w.Modes) == 0 || len(w.Modes) > 2 {
			return fmt.Errorf("widget %s: sizes and modes required", w.ID)
		}
		for _, list := range []struct {
			values []string
			valid  map[string]bool
		}{{w.Sizes, WidgetSizes}, {w.Modes, HomeModes}} {
			dup := map[string]bool{}
			for _, v := range list.values {
				if !list.valid[v] || dup[v] {
					return fmt.Errorf("widget %s: invalid size or mode", w.ID)
				}
				dup[v] = true
			}
		}
		for mode, order := range w.Default {
			if !HomeModes[mode] || order < 0 || order > 1000 {
				return fmt.Errorf("widget %s: invalid default", w.ID)
			}
		}
		if w.Kind == "custom" {
			if w.Data != "" && !m.Allows(w.Data) {
				return fmt.Errorf("widget %s: data outside backend paths", w.ID)
			}
		} else if !m.Allows(w.Data) {
			return fmt.Errorf("widget %s: data outside backend paths", w.ID)
		}
		if w.Refresh != 0 && (w.Refresh < 10 || w.Refresh > 3600) {
			return fmt.Errorf("widget %s: refresh out of range", w.ID)
		}
		if w.Page != "" && !pages[w.Page] {
			return fmt.Errorf("widget %s: unknown page", w.ID)
		}
	}
	if s := m.UI.Summary; s != nil {
		for _, p := range []string{s.Attention, s.Tasks} {
			if p != "" && !m.Allows(p) {
				return fmt.Errorf("summary outside backend paths")
			}
		}
	}
	return nil
}

// RefreshSeconds is how long a widget's data stays fresh.
func (w Widget) RefreshSeconds() int {
	if w.Refresh == 0 {
		return 60
	}
	return w.Refresh
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
