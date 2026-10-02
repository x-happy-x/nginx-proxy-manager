package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// /api/core/* is HomeNet's own side of the Mihomo console: installation
// state, device names from Keenetic and validated edits of config.yaml.
// Runtime calls (select a node, close a connection) go through /api/mihomo/*.

var coreConfigMu sync.Mutex

const coreSecretMask = "••••••••"

func coreBinary() string {
	if v := strings.TrimSpace(os.Getenv("MIHOMO_BINARY")); v != "" {
		return v
	}
	for _, p := range []string{"/opt/sbin/mihomo", "/opt/bin/mihomo", "/usr/bin/mihomo"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return "/opt/sbin/mihomo"
}

func coreConfigPath() string { return getenv("MIHOMO_CONFIG", "/opt/etc/mihomo/config.yaml") }

func coreStateDir() string { return getenv("MIHOMO_STATE_DIR", "/opt/etc/homenet/mihomo") }

func coreSettings() (mihomoSettings, error) {
	u, secret, err := mihomoControllerURL()
	if err != nil {
		return mihomoSettings{}, err
	}
	cfg := coreConfigPath()
	if !filepath.IsAbs(cfg) {
		return mihomoSettings{}, fmt.Errorf("MIHOMO_CONFIG должен быть абсолютным путём")
	}
	home := strings.TrimSpace(os.Getenv("MIHOMO_HOME"))
	if home == "" {
		home = filepath.Dir(cfg)
	}
	return mihomoSettings{config: cfg, binary: coreBinary(), controller: strings.TrimRight(u.String(), "/"), home: home, secret: secret}, nil
}

// coreAsset is the release archive suffix of x-happy-x/mihomo for this CPU.
func coreAsset() string {
	switch runtime.GOARCH {
	case "arm64":
		return "linux-arm64"
	case "arm":
		return "linux-armv7"
	case "amd64":
		if runtime.GOOS == "windows" {
			return "windows-amd64-v1"
		}
		return "linux-amd64-v1"
	case "mipsle":
		return "linux-mipsle-softfloat"
	case "mips":
		return "linux-mips-hardfloat"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

type coreStatus struct {
	Installed    bool   `json:"installed"`
	Binary       string `json:"binary"`
	Config       string `json:"config"`
	ConfigExists bool   `json:"config_exists"`
	Running      bool   `json:"running"`
	Version      string `json:"version,omitempty"`
	Meta         bool   `json:"meta"`
	Fork         bool   `json:"fork"`
	ControllerOK bool   `json:"controller_ok"`
	Controller   string `json:"controller"`
	Error        string `json:"error,omitempty"`
	XKeen        bool   `json:"xkeen"`
	Arch         string `json:"arch"`
	Asset        string `json:"asset"`
	CanEdit      bool   `json:"can_edit"`
}

func readCoreStatus() coreStatus {
	st := coreStatus{Binary: coreBinary(), Config: coreConfigPath(), Arch: runtime.GOOS + "/" + runtime.GOARCH, Asset: coreAsset()}
	if fi, err := os.Stat(st.Binary); err == nil && !fi.IsDir() {
		st.Installed = true
	}
	if _, err := os.Stat(st.Config); err == nil {
		st.ConfigExists = true
	}
	for _, p := range []string{"/opt/sbin/xkeen", "/opt/bin/xkeen"} {
		if _, err := os.Stat(p); err == nil {
			st.XKeen = true
		}
	}
	if u, _, err := mihomoControllerURL(); err == nil {
		st.Controller = u.Host
	}
	var ver struct {
		Version string `json:"version"`
		Meta    bool   `json:"meta"`
	}
	if err := mihomoGet("/version", &ver); err == nil {
		st.ControllerOK, st.Running = true, true
		st.Version, st.Meta = ver.Version, ver.Meta
		st.Fork = strings.Contains(ver.Version, "fork")
		// A running core proves an installation even at a non-standard path.
		st.Installed = true
	} else {
		st.Error = err.Error()
	}
	st.CanEdit = st.Installed && st.ConfigExists
	return st
}

/* ---------- devices ---------- */

type coreDevice struct {
	IP       string `json:"ip"`
	MAC      string `json:"mac,omitempty"`
	Name     string `json:"name"`
	Hostname string `json:"hostname,omitempty"`
	Source   string `json:"source"` // keenetic | homenet
	Active   bool   `json:"active"`
	Segment  string `json:"segment,omitempty"`
}

func coreLabelsPath() string { return filepath.Join(coreStateDir(), "device-labels.json") }

func loadCoreLabels() map[string]string {
	labels := map[string]string{}
	if raw, err := os.ReadFile(coreLabelsPath()); err == nil {
		_ = json.Unmarshal(raw, &labels)
	}
	return labels
}

func saveCoreLabels(labels map[string]string) error {
	clean := map[string]string{}
	for ip, name := range labels {
		ip, name = strings.TrimSpace(ip), strings.TrimSpace(name)
		if ip == "" || name == "" {
			continue
		}
		if len(name) > 64 || strings.ContainsAny(name, "\n\r\t") {
			return fmt.Errorf("недопустимое имя устройства для %s", ip)
		}
		clean[ip] = name
	}
	body, _ := json.MarshalIndent(clean, "", "  ")
	if err := os.MkdirAll(coreStateDir(), 0o755); err != nil {
		return err
	}
	tmp := coreLabelsPath() + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, coreLabelsPath())
}

// keeneticDevices reads the router's host list (the names shown in the
// Keenetic web UI) and overlays the operator's own labels.
func keeneticDevices() ([]coreDevice, error) {
	var hotspot struct {
		Host []struct {
			MAC       string `json:"mac"`
			IP        string `json:"ip"`
			Hostname  string `json:"hostname"`
			Name      string `json:"name"`
			Active    bool   `json:"active"`
			Interface struct {
				ID string `json:"id"`
			} `json:"interface"`
		} `json:"host"`
	}
	err := rciGet("/show/ip/hotspot", &hotspot)
	labels := loadCoreLabels()
	seen := map[string]bool{}
	out := []coreDevice{}
	for _, h := range hotspot.Host {
		if h.IP == "" || h.IP == "0.0.0.0" {
			continue
		}
		d := coreDevice{IP: h.IP, MAC: h.MAC, Hostname: h.Hostname, Name: firstNonEmpty(h.Name, h.Hostname, h.MAC), Source: "keenetic", Active: h.Active, Segment: h.Interface.ID}
		if l, ok := labels[h.IP]; ok {
			d.Name, d.Source = l, "homenet"
		}
		seen[h.IP] = true
		out = append(out, d)
	}
	for ip, name := range labels {
		if !seen[ip] {
			out = append(out, coreDevice{IP: ip, Name: name, Source: "homenet"})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Active != out[j].Active {
			return out[i].Active
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, err
}

/* ---------- config ---------- */

// Sections the console edits as structured data. Everything else in
// config.yaml (comments included) is left as it was.
var coreEditableSections = map[string]bool{
	"proxies": true, "proxy-providers": true, "proxy-groups": true, "rules": true, "rule-providers": true,
	"dns": true, "tun": true, "sniffer": true, "hosts": true, "mode": true, "log-level": true,
	"allow-lan": true, "ipv6": true, "mixed-port": true, "port": true, "socks-port": true,
	"redir-port": true, "tproxy-port": true, "unified-delay": true, "tcp-concurrent": true,
	"find-process-mode": true, "geodata-mode": true, "geox-url": true, "profile": true,
}

// The controller must stay reachable for HomeNet; these keys never change
// from the console, not even through the raw YAML editor.
var coreProtectedKeys = []string{"secret", "external-controller", "external-controller-tls", "external-controller-unix", "external-ui", "external-ui-url", "external-ui-name"}

func configSHA(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func yamlRoot(body []byte) (*yaml.Node, *yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return nil, nil, fmt.Errorf("config.yaml не разбирается: %v", err)
	}
	if len(doc.Content) == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("config.yaml должен быть YAML-словарём")
	}
	return &doc, root, nil
}

func yamlSet(root *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == key {
			if value == nil {
				root.Content = append(root.Content[:i], root.Content[i+2:]...)
			} else {
				// Keep a comment attached to the old value.
				value.HeadComment, value.LineComment = root.Content[i+1].HeadComment, root.Content[i+1].LineComment
				root.Content[i+1] = value
			}
			return
		}
	}
	if value != nil {
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	}
}

func yamlGet(root *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == key {
			return root.Content[i+1]
		}
	}
	return nil
}

func encodeYAML(doc *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

// maskConfig hides the controller secret before the YAML leaves the router.
func maskConfig(body []byte) ([]byte, map[string]any, error) {
	doc, root, err := yamlRoot(body)
	if err != nil {
		return nil, nil, err
	}
	if n := yamlGet(root, "secret"); n != nil && n.Kind == yaml.ScalarNode && n.Value != "" {
		n.Value = coreSecretMask
		n.Style = yaml.DoubleQuotedStyle
	}
	masked, err := encodeYAML(doc)
	if err != nil {
		return nil, nil, err
	}
	sections := map[string]any{}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key := root.Content[i].Value
		if !coreEditableSections[key] {
			continue
		}
		var v any
		if err := root.Content[i+1].Decode(&v); err == nil {
			sections[key] = v
		}
	}
	return masked, sections, nil
}

type configEdit struct {
	SHA  string                     `json:"sha"`
	Set  map[string]json.RawMessage `json:"set,omitempty"`
	YAML *string                    `json:"yaml,omitempty"`
}

// buildCandidate applies either a raw YAML replacement or structured section
// replacements to original. Protected keys always keep their original value.
func buildCandidate(original []byte, edit configEdit) ([]byte, error) {
	_, origRoot, err := yamlRoot(original)
	if err != nil {
		return nil, err
	}
	var doc *yaml.Node
	var root *yaml.Node
	if edit.YAML != nil {
		doc, root, err = yamlRoot([]byte(*edit.YAML))
		if err != nil {
			return nil, err
		}
	} else {
		doc, root, _ = yamlRoot(original)
		keys := make([]string, 0, len(edit.Set))
		for k := range edit.Set {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if !coreEditableSections[key] {
				return nil, fmt.Errorf("раздел %q нельзя менять из HomeNet", key)
			}
			raw := edit.Set[key]
			if string(bytes.TrimSpace(raw)) == "null" {
				yamlSet(root, key, nil)
				continue
			}
			var value any
			if err := json.Unmarshal(raw, &value); err != nil {
				return nil, fmt.Errorf("раздел %s: %v", key, err)
			}
			var node yaml.Node
			if err := node.Encode(value); err != nil {
				return nil, fmt.Errorf("раздел %s: %v", key, err)
			}
			yamlSet(root, key, &node)
		}
	}
	for _, key := range coreProtectedKeys {
		orig := yamlGet(origRoot, key)
		if orig == nil {
			yamlSet(root, key, nil)
			continue
		}
		clone := *orig
		yamlSet(root, key, &clone)
	}
	return encodeYAML(doc)
}

type configChange struct {
	Section string `json:"section"`
	Kind    string `json:"kind"` // added | removed | changed
	Item    string `json:"item,omitempty"`
}

func itemLabel(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		if n, ok := t["name"].(string); ok {
			return n
		}
	}
	b, _ := json.Marshal(v)
	if len(b) > 120 {
		b = append(b[:117], "..."...)
	}
	return string(b)
}

// diffConfig summarizes what changes between two configs, per top-level
// section and item, without printing secrets the items might carry.
func diffConfig(a, b []byte) []configChange {
	var ma, mb map[string]any
	_ = yaml.Unmarshal(a, &ma)
	_ = yaml.Unmarshal(b, &mb)
	keys := map[string]bool{}
	for k := range ma {
		keys[k] = true
	}
	for k := range mb {
		keys[k] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	out := []configChange{}
	same := func(x, y any) bool {
		bx, _ := json.Marshal(x)
		by, _ := json.Marshal(y)
		return bytes.Equal(bx, by)
	}
	for _, k := range sorted {
		va, oka := ma[k]
		vb, okb := mb[k]
		switch {
		case !oka:
			out = append(out, configChange{Section: k, Kind: "added"})
		case !okb:
			out = append(out, configChange{Section: k, Kind: "removed"})
		case same(va, vb):
		default:
			sa, isSeqA := va.([]any)
			sb, isSeqB := vb.([]any)
			pa, isMapA := va.(map[string]any)
			pb, isMapB := vb.(map[string]any)
			switch {
			case isSeqA && isSeqB:
				out = append(out, diffSeq(k, sa, sb)...)
			case isMapA && isMapB && (k == "proxy-providers" || k == "rule-providers" || k == "hosts"):
				for name, v := range pb {
					if old, ok := pa[name]; !ok {
						out = append(out, configChange{Section: k, Kind: "added", Item: name})
					} else if !same(old, v) {
						out = append(out, configChange{Section: k, Kind: "changed", Item: name})
					}
				}
				for name := range pa {
					if _, ok := pb[name]; !ok {
						out = append(out, configChange{Section: k, Kind: "removed", Item: name})
					}
				}
			default:
				out = append(out, configChange{Section: k, Kind: "changed"})
			}
		}
	}
	if len(out) > 200 {
		out = append(out[:200], configChange{Section: "…", Kind: "changed", Item: fmt.Sprintf("ещё %d изменений", len(out)-200)})
	}
	return out
}

func diffSeq(section string, a, b []any) []configChange {
	key := func(v any) string { j, _ := json.Marshal(v); return string(j) }
	byName := func(items []any) map[string]any {
		m := map[string]any{}
		for _, it := range items {
			if mm, ok := it.(map[string]any); ok {
				if n, ok := mm["name"].(string); ok {
					m[n] = it
				}
			}
		}
		return m
	}
	out := []configChange{}
	na, nb := byName(a), byName(b)
	if len(na) == len(a) && len(nb) == len(b) && len(a)+len(b) > 0 {
		for name, v := range nb {
			if old, ok := na[name]; !ok {
				out = append(out, configChange{Section: section, Kind: "added", Item: name})
			} else if key(old) != key(v) {
				out = append(out, configChange{Section: section, Kind: "changed", Item: name})
			}
		}
		for name := range na {
			if _, ok := nb[name]; !ok {
				out = append(out, configChange{Section: section, Kind: "removed", Item: name})
			}
		}
	} else {
		count := map[string]int{}
		for _, it := range a {
			count[key(it)]--
		}
		for _, it := range b {
			count[key(it)]++
		}
		for _, it := range b {
			if count[key(it)] > 0 {
				count[key(it)]--
				out = append(out, configChange{Section: section, Kind: "added", Item: itemLabel(it)})
			}
		}
		for _, it := range a {
			if count[key(it)] < 0 {
				count[key(it)]++
				out = append(out, configChange{Section: section, Kind: "removed", Item: itemLabel(it)})
			}
		}
		if len(out) == 0 {
			out = append(out, configChange{Section: section, Kind: "changed", Item: "изменён порядок"})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Item < out[j].Item })
	return out
}

func readActiveConfig(s mihomoSettings) (string, []byte, error) {
	target, err := filepath.EvalSymlinks(s.config)
	if err != nil {
		return "", nil, fmt.Errorf("конфиг mihomo не найден: %s", s.config)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		return "", nil, fmt.Errorf("не удалось прочитать конфиг mihomo: %v", err)
	}
	return target, body, nil
}

type coreBackup struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Time string `json:"time"`
}

func listCoreBackups(target string) []coreBackup {
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(target), ".homenet-backup-*.yaml"))
	out := []coreBackup{}
	for _, m := range matches {
		if fi, err := os.Stat(m); err == nil {
			out = append(out, coreBackup{Name: filepath.Base(m), Size: fi.Size(), Time: fi.ModTime().UTC().Format("2006-01-02T15:04:05Z")})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Time > out[j].Time })
	if len(out) > 30 {
		out = out[:30]
	}
	return out
}

/* ---------- handlers ---------- */

func (a *app) handleCoreGet(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/core/status":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "status": readCoreStatus()})
	case "/api/core/devices":
		devices, err := keeneticDevices()
		res := response{"ok": true, "devices": devices}
		if err != nil {
			res["warning"] = "список устройств Keenetic недоступен: " + shortNetErr(err).Error()
		}
		a.writeJSON(w, http.StatusOK, res)
	case "/api/core/config":
		s, err := coreSettings()
		if err != nil {
			a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": err.Error()})
			return
		}
		target, body, err := readActiveConfig(s)
		if err != nil {
			a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": err.Error()})
			return
		}
		masked, sections, err := maskConfig(body)
		if err != nil {
			a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": err.Error()})
			return
		}
		_, binErr := os.Stat(s.binary)
		a.writeJSON(w, http.StatusOK, response{
			"ok": true, "path": s.config, "target": target, "sha": configSHA(body),
			"yaml": string(masked), "sections": sections, "backups": listCoreBackups(target),
			"can_validate": binErr == nil,
		})
	case "/api/core/install/plan":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "plan": installPlan(r.URL.Query().Get("xkeen") == "1")})
	case "/api/core/health":
		a.handleCoreHealth(w, r)
	case "/api/core/traffic":
		a.handleCoreTraffic(w, r)
	case "/api/core/install/log":
		a.writeJSON(w, http.StatusOK, response{"ok": true, "install": installer.snapshot()})
	default:
		http.NotFound(w, r)
	}
}

func (a *app) handleCorePost(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/core/devices":
		var req struct {
			Labels map[string]string `json:"labels"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		if err := saveCoreLabels(req.Labels); err != nil {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true})
	case "/api/core/traffic/reset":
		a.handleCoreTrafficReset(w)
	case "/api/core/config/check", "/api/core/config/apply":
		a.handleCoreConfigWrite(w, r, r.URL.Path == "/api/core/config/apply")
	case "/api/core/install":
		var req installRequest
		if !a.decodeJSON(w, r, &req) {
			return
		}
		if err := installer.start(req); err != nil {
			a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusAccepted, response{"ok": true, "install": installer.snapshot()})
	default:
		http.NotFound(w, r)
	}
}

func (a *app) handleCoreConfigWrite(w http.ResponseWriter, r *http.Request, apply bool) {
	var edit configEdit
	if !a.decodeJSON(w, r, &edit) {
		return
	}
	coreConfigMu.Lock()
	defer coreConfigMu.Unlock()
	s, err := coreSettings()
	if err != nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": err.Error()})
		return
	}
	target, original, err := readActiveConfig(s)
	if err != nil {
		a.writeJSON(w, http.StatusNotFound, response{"ok": false, "error": err.Error()})
		return
	}
	if edit.SHA != configSHA(original) {
		a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": "config.yaml изменился с момента загрузки; обновите страницу и повторите", "sha": configSHA(original)})
		return
	}
	candidate, err := buildCandidate(original, edit)
	if err != nil {
		a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": err.Error()})
		return
	}
	changes := diffConfig(original, candidate)
	if len(changes) == 0 {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "changes": changes, "valid": true, "message": "изменений нет"})
		return
	}
	if _, err := os.Stat(s.binary); err != nil {
		a.writeJSON(w, http.StatusFailedDependency, response{"ok": false, "changes": changes, "error": "бинарник mihomo не найден (" + s.binary + "): проверить конфиг нечем"})
		return
	}
	if !apply {
		staged, err := mihomoPrivateFile(filepath.Dir(target), ".homenet-staged-*.yaml", candidate)
		if err != nil {
			a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
			return
		}
		defer os.Remove(staged)
		if err := mihomoValidateCandidate(s, staged); err != nil {
			a.writeJSON(w, http.StatusOK, response{"ok": true, "valid": false, "changes": changes, "message": "mihomo -t отклонил конфигурацию"})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "valid": true, "changes": changes, "message": "mihomo -t: конфигурация корректна"})
		return
	}
	backup, err := mihomoSwapConfig(s, target, original, candidate, "config", mihomoValidateCandidate, mihomoReload)
	if err != nil {
		a.writeJSON(w, http.StatusOK, response{"ok": false, "changes": changes, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "valid": true, "applied": true, "changes": changes, "backup": filepath.Base(backup), "sha": configSHA(candidate),
		"message": fmt.Sprintf("Применено %d изменений; копия %s", len(changes), filepath.Base(backup))})
}

/* ---------- releases (NPM-30) ---------- */

type releaseInfo struct {
	Name      string `json:"name"`
	Time      string `json:"time"`
	Committed bool   `json:"committed"`
	Rollback  bool   `json:"rollback"`
	Current   bool   `json:"current"`
	Staged    bool   `json:"staged"`
}

// listReleases reads the deploy script's release folders; read-only.
func listReleases(dir string) ([]releaseInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []releaseInfo{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		exists := func(name string) bool { _, err := os.Stat(filepath.Join(path, name)); return err == nil }
		out = append(out, releaseInfo{
			Name: e.Name(), Time: info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
			Committed: exists("COMMITTED"), Rollback: exists("rollback.sh"), Staged: exists("start-staged.sh") && !exists("rollback.sh"),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	for i := range out {
		if out[i].Committed && out[i].Rollback {
			out[i].Current = true
			break
		}
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return out, nil
}

func (a *app) handleReleases(w http.ResponseWriter) {
	list, err := listReleases(getenv("HOMENET_RELEASES_DIR", "/opt/etc/homenet/releases"))
	if err != nil {
		a.writeJSON(w, http.StatusOK, response{"ok": true, "releases": []releaseInfo{}, "note": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "releases": list})
}
