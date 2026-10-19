package main

// NPM-76: the «Умный дом» integration. Once a minute the worker reads Home Assistant's
// REST API (/api/config and /api/states) with a long-lived token of a dedicated HA
// user and keeps a digest in memory: devices on line, Zigbee2MQTT bridge, batteries,
// updates, lights and the last automatic backup. Entities are matched to devices
// through POST /api/template (admin only); without it the digest falls back to
// entities. Widget and attention endpoints answer from memory and never touch the network.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	haPollEvery       = time.Minute
	haDeviceMapEvery  = 10 * time.Minute
	haOfflineAfter    = 15 * time.Minute
	haBridgeAfter     = 2 * time.Minute
	haBatteryLow      = 20.0
	haBackupMaxAge    = 48 * time.Hour
	haBridgeEntity    = "binary_sensor.zigbee2mqtt_bridge_connection_state"
	haBackupEntity    = "sensor.backup_last_successful_automatic_backup"
	haAttentionDetail = 5 // more problems of one kind are folded into one line
)

// haDeviceTemplate maps entities to their devices in one render. HA's sandbox cannot
// mutate dicts, so rows are lists; identifiers tell Zigbee2MQTT devices apart.
const haDeviceTemplate = `{%- set ns = namespace(rows=[], devs=[]) -%}
{%- for s in states -%}{%- set d = device_id(s.entity_id) -%}
{%- if d -%}{%- set ns.rows = ns.rows + [[s.entity_id, d]] -%}{%- endif -%}
{%- endfor -%}
{%- for d in ns.rows | map(attribute=1) | unique -%}
{%- set ids = device_attr(d, 'identifiers') or [] -%}
{%- set ns.devs = ns.devs + [[d, device_attr(d, 'name_by_user') or device_attr(d, 'name') or '', area_name(d) or '', ids | map('join', ':') | join(' '), device_attr(d, 'disabled_by') is not none]] -%}
{%- endfor -%}
{{ {'e': ns.rows, 'd': ns.devs} | tojson }}`

type haConfig struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type haState struct {
	EntityID    string    `json:"entity_id"`
	State       string    `json:"state"`
	LastChanged time.Time `json:"last_changed"`
	Attributes  struct {
		FriendlyName     string          `json:"friendly_name"`
		DeviceClass      string          `json:"device_class"`
		Unit             string          `json:"unit_of_measurement"`
		Title            string          `json:"title"`
		InstalledVersion string          `json:"installed_version"`
		LatestVersion    string          `json:"latest_version"`
		Members          json.RawMessage `json:"entity_id"` // set on light groups
	} `json:"attributes"`
}

func (s haState) name() string {
	if s.Attributes.FriendlyName != "" {
		return s.Attributes.FriendlyName
	}
	return s.EntityID
}

func (s haState) domain() string {
	if i := strings.IndexByte(s.EntityID, '.'); i > 0 {
		return s.EntityID[:i]
	}
	return ""
}

type haInfo struct {
	Version      string `json:"version"`
	LocationName string `json:"location_name"`
	ExternalURL  string `json:"external_url"`
	InternalURL  string `json:"internal_url"`
	State        string `json:"state"`
}

type haDevice struct {
	ID       string
	Name     string
	Area     string
	Zigbee   bool
	Disabled bool
}

type haDeviceMap struct {
	Entities map[string]string // entity_id → device id
	Devices  map[string]haDevice
}

func parseHADeviceMap(rendered string) (*haDeviceMap, error) {
	var raw struct {
		E [][2]string         `json:"e"`
		D [][]json.RawMessage `json:"d"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(rendered)), &raw); err != nil {
		return nil, fmt.Errorf("шаблон устройств вернул не JSON: %w", err)
	}
	m := &haDeviceMap{Entities: map[string]string{}, Devices: map[string]haDevice{}}
	for _, row := range raw.D {
		if len(row) < 5 {
			continue
		}
		var d haDevice
		var ids string
		_ = json.Unmarshal(row[0], &d.ID)
		_ = json.Unmarshal(row[1], &d.Name)
		_ = json.Unmarshal(row[2], &d.Area)
		_ = json.Unmarshal(row[3], &ids)
		_ = json.Unmarshal(row[4], &d.Disabled)
		if d.ID == "" {
			continue
		}
		d.Zigbee = strings.Contains(ids, "zigbee2mqtt")
		m.Devices[d.ID] = d
	}
	for _, row := range raw.E {
		if _, ok := m.Devices[row[1]]; ok {
			m.Entities[row[0]] = row[1]
		}
	}
	return m, nil
}

// Digest of one poll: everything the widget, the attention list and the page need.

type haOffline struct {
	Name     string    `json:"name"`
	Area     string    `json:"area,omitempty"`
	Entities int       `json:"entities"`
	Since    time.Time `json:"since"`
	Zigbee   bool      `json:"zigbee"`
}

type haBattery struct {
	Name  string   `json:"name"`
	Area  string   `json:"area,omitempty"`
	Level *float64 `json:"level"` // nil for binary «low battery» sensors
	Low   bool     `json:"low"`
}

type haUpdate struct {
	Entity    string `json:"entity"`
	Name      string `json:"name"`
	Installed string `json:"installed"`
	Latest    string `json:"latest"`
}

type haLight struct {
	Name string `json:"name"`
	Area string `json:"area,omitempty"`
}

type haView struct {
	ByDevice    bool        `json:"by_device"` // false: no device map, counted by entities
	Total       int         `json:"total"`
	Online      int         `json:"online"`
	Offline     []haOffline `json:"offline"`     // past haOfflineAfter, Zigbee ones hidden while the bridge is down
	ZigbeeDown  int         `json:"zigbee_down"` // Zigbee devices off line behind a down bridge
	Bridge      *haBridge   `json:"bridge"`      // nil: no Zigbee2MQTT bridge sensor
	Batteries   []haBattery `json:"batteries"`   // all, lowest first
	Updates     []haUpdate  `json:"updates"`
	Lights      []haLight   `json:"lights"`
	Backup      *haBackup   `json:"backup"` // nil: no backup sensor
	EntityCount int         `json:"entity_count"`
}

type haBridge struct {
	Online bool      `json:"online"`
	State  string    `json:"state"`
	Since  time.Time `json:"since"`
}

type haBackup struct {
	Last  *time.Time `json:"last"` // nil: no automatic backup yet
	State string     `json:"state"`
}

func (v haView) lowBatteries() []haBattery {
	out := []haBattery{}
	for _, b := range v.Batteries {
		if b.Low {
			out = append(out, b)
		}
	}
	return out
}

func (v haView) bridgeDown(now time.Time) bool {
	return v.Bridge != nil && !v.Bridge.Online && now.Sub(v.Bridge.Since) >= haBridgeAfter
}

func haAnalyze(states []haState, dm *haDeviceMap, now time.Time) haView {
	v := haView{ByDevice: dm != nil, Offline: []haOffline{}, Batteries: []haBattery{}, Updates: []haUpdate{}, Lights: []haLight{}, EntityCount: len(states)}
	deviceOf := func(entity string) (haDevice, bool) {
		if dm == nil {
			return haDevice{}, false
		}
		id, ok := dm.Entities[entity]
		if !ok {
			return haDevice{}, false
		}
		d, ok := dm.Devices[id]
		return d, ok
	}
	for _, s := range states {
		if s.EntityID == haBridgeEntity {
			v.Bridge = &haBridge{Online: s.State == "on", State: s.State, Since: s.LastChanged}
		}
		if s.EntityID == haBackupEntity {
			b := &haBackup{State: s.State}
			if t, err := time.Parse(time.RFC3339, s.State); err == nil {
				b.Last = &t
			}
			v.Backup = b
		}
	}
	bridgeDown := v.bridgeDown(now)

	// Devices: a device is off line when every entity it has in the state machine is
	// unavailable. Disabled entities have no state and do not count; disabled devices are skipped.
	type agg struct {
		dev         haDevice
		total, down int
		since       time.Time
	}
	groups := map[string]*agg{}
	order := []string{}
	for _, s := range states {
		key, dev := "", haDevice{}
		if d, ok := deviceOf(s.EntityID); ok {
			if d.Disabled {
				continue
			}
			key, dev = "d:"+d.ID, d
			if dev.Name == "" {
				dev.Name = s.name()
			}
		} else if dm == nil {
			key, dev = "e:"+s.EntityID, haDevice{Name: s.name()}
		} else {
			continue // helpers, automations, sun… are not devices
		}
		g := groups[key]
		if g == nil {
			g = &agg{dev: dev}
			groups[key] = g
			order = append(order, key)
		}
		g.total++
		if s.State == "unavailable" {
			g.down++
			if s.LastChanged.After(g.since) {
				g.since = s.LastChanged
			}
		}
	}
	for _, key := range order {
		g := groups[key]
		v.Total++
		if g.down < g.total {
			v.Online++
			continue
		}
		if g.dev.Zigbee && bridgeDown {
			v.ZigbeeDown++
			continue
		}
		if now.Sub(g.since) < haOfflineAfter {
			continue
		}
		v.Offline = append(v.Offline, haOffline{Name: g.dev.Name, Area: g.dev.Area, Entities: g.total, Since: g.since, Zigbee: g.dev.Zigbee})
	}
	sort.SliceStable(v.Offline, func(i, j int) bool { return v.Offline[i].Since.Before(v.Offline[j].Since) })

	// Batteries: one line per device (the lowest reading wins).
	batteries := map[string]int{}
	for _, s := range states {
		if s.Attributes.DeviceClass != "battery" || s.State == "unavailable" || s.State == "unknown" {
			continue
		}
		var b haBattery
		switch s.domain() {
		case "sensor":
			level, err := strconv.ParseFloat(s.State, 64)
			if err != nil || (s.Attributes.Unit != "" && s.Attributes.Unit != "%") {
				continue
			}
			b = haBattery{Level: &level, Low: level < haBatteryLow}
		case "binary_sensor":
			b = haBattery{Low: s.State == "on"}
		default:
			continue
		}
		key := "e:" + s.EntityID
		b.Name = s.name()
		if d, ok := deviceOf(s.EntityID); ok {
			if d.Disabled {
				continue
			}
			key, b.Name, b.Area = "d:"+d.ID, d.Name, d.Area
		}
		if i, ok := batteries[key]; ok {
			prev := &v.Batteries[i]
			prev.Low = prev.Low || b.Low
			if b.Level != nil && (prev.Level == nil || *b.Level < *prev.Level) {
				prev.Level = b.Level
			}
			continue
		}
		batteries[key] = len(v.Batteries)
		v.Batteries = append(v.Batteries, b)
	}
	sort.SliceStable(v.Batteries, func(i, j int) bool {
		a, b := v.Batteries[i], v.Batteries[j]
		if a.Low != b.Low {
			return a.Low
		}
		if a.Level == nil || b.Level == nil {
			return a.Level == nil && b.Level != nil
		}
		return *a.Level < *b.Level
	})

	for _, s := range states {
		switch s.domain() {
		case "update":
			if s.State != "on" {
				continue
			}
			name := s.Attributes.Title
			if name == "" {
				name = strings.TrimSuffix(s.name(), " Update")
			}
			v.Updates = append(v.Updates, haUpdate{Entity: s.EntityID, Name: name, Installed: s.Attributes.InstalledVersion, Latest: s.Attributes.LatestVersion})
		case "light":
			if s.State != "on" || (len(s.Attributes.Members) > 0 && string(s.Attributes.Members) != "null") {
				continue // light groups would count their members twice
			}
			l := haLight{Name: s.name()}
			if d, ok := deviceOf(s.EntityID); ok {
				l.Area = d.Area
			}
			v.Lights = append(v.Lights, l)
		}
	}
	sort.SliceStable(v.Updates, func(i, j int) bool { return v.Updates[i].Name < v.Updates[j].Name })
	sort.SliceStable(v.Lights, func(i, j int) bool { return v.Lights[i].Name < v.Lights[j].Name })
	return v
}

// Monitor: configuration, the last successful poll and the connection state.

type haMonitor struct {
	mu       sync.Mutex
	dir      string
	client   *http.Client
	cfg      haConfig
	loadErr  string
	info     haInfo
	states   []haState
	view     *haView
	devmap   *haDeviceMap
	devmapAt time.Time
	mapErr   string
	err      string
	authErr  bool
	errSince time.Time
	checked  time.Time
	lastOK   time.Time
	pollMu   sync.Mutex
}

var ha *haMonitor

func haDir() string { return getenv("HA_DIR", "/opt/etc/homenet/ha") }

func newHAMonitor() *haMonitor {
	m := &haMonitor{dir: haDir(), client: &http.Client{Timeout: 20 * time.Second}}
	b, err := os.ReadFile(filepath.Join(m.dir, "config.json"))
	if os.IsNotExist(err) {
		return m // nothing configured yet: the «Настройка» page sets the address and token
	}
	if err != nil {
		m.loadErr = "Настройки не читаются: " + err.Error()
		return m
	}
	if err = json.Unmarshal(b, &m.cfg); err != nil {
		m.loadErr = "Настройки повреждены: " + err.Error()
		return m
	}
	m.cfg.URL = strings.TrimRight(strings.TrimSpace(m.cfg.URL), "/")
	m.cfg.Token = strings.TrimSpace(m.cfg.Token)
	return m
}

func (a *app) startHA() {
	ha = newHAMonitor()
	every(haPollEvery, ha.poll)
}

func (m *haMonitor) configured() bool { return m.cfg.URL != "" && m.cfg.Token != "" }

type haHTTPError struct {
	Status int
	Body   string
}

func (e *haHTTPError) Error() string {
	switch e.Status {
	case 401:
		return "токен отклонён (401)"
	case 403:
		return "недостаточно прав (403)"
	}
	if e.Body != "" {
		return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body)
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

func (m *haMonitor) call(ctx context.Context, cfg haConfig, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfg.URL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("нет ответа")
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			return ue.Err
		}
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return &haHTTPError{Status: res.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	// /api/states of a large home is a few megabytes; the template answer is plain text.
	if s, ok := out.(*string); ok {
		b, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
		*s = string(b)
		return err
	}
	return json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(out)
}

func (m *haMonitor) poll() {
	m.pollMu.Lock()
	defer m.pollMu.Unlock()
	m.mu.Lock()
	cfg, devmap, devmapAt := m.cfg, m.devmap, m.devmapAt
	m.mu.Unlock()
	if cfg.URL == "" || cfg.Token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(workerContext, 45*time.Second)
	defer cancel()
	var info haInfo
	var states []haState
	err := m.call(ctx, cfg, "GET", "/api/config", nil, &info)
	if err == nil {
		err = m.call(ctx, cfg, "GET", "/api/states", nil, &states)
	}
	mapErr := ""
	if err == nil && (devmap == nil || time.Since(devmapAt) >= haDeviceMapEvery) {
		var rendered string
		if e := m.call(ctx, cfg, "POST", "/api/template", map[string]string{"template": haDeviceTemplate}, &rendered); e != nil {
			mapErr = e.Error()
		} else if dm, e := parseHADeviceMap(rendered); e != nil {
			mapErr = e.Error()
		} else {
			devmap, devmapAt = dm, time.Now()
		}
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg != cfg {
		return // settings changed while polling: the next round uses the new ones
	}
	m.checked = now
	if err != nil {
		if m.err == "" {
			m.errSince = now
		}
		m.err = err.Error()
		var he *haHTTPError
		m.authErr = errors.As(err, &he) && (he.Status == 401 || he.Status == 403)
		return
	}
	m.err, m.authErr, m.errSince, m.lastOK = "", false, time.Time{}, now
	m.info, m.states = info, states
	if mapErr != "" {
		// keep an older map: entities rarely move between devices
		m.mapErr = mapErr
	} else if devmap != m.devmap {
		m.mapErr = ""
	}
	m.devmap, m.devmapAt = devmap, devmapAt
	view := haAnalyze(states, devmap, now)
	m.view = &view
}

// link is where «Открыть Home Assistant» leads: the address HA itself advertises
// for the outside, else the one the worker uses.
func (m *haMonitor) link() string {
	if m.info.ExternalURL != "" {
		return m.info.ExternalURL
	}
	return m.cfg.URL
}

func (m *haMonitor) online() bool { return m.err == "" && m.view != nil }

func (a *app) handleHA(w http.ResponseWriter, r *http.Request) {
	if ha == nil {
		http.Error(w, "integration not started", 503)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/ha/config") {
		a.handleHAConfig(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	switch r.URL.Path {
	case "/api/ha/overview":
		a.writeJSON(w, 200, ha.overview())
	case "/api/ha/widgets/home":
		a.writeJSON(w, 200, ha.widgetHome(time.Now()))
	case "/api/ha/summary/attention":
		a.writeJSON(w, 200, response{"items": ha.attention(time.Now())})
	default:
		http.NotFound(w, r)
	}
}

func haTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func (m *haMonitor) overview() response {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := response{
		"configured": m.configured(), "error": m.err, "auth_error": m.authErr, "load_error": m.loadErr, "map_error": m.mapErr,
		"url": m.cfg.URL, "link": m.link(), "version": m.info.Version, "location": m.info.LocationName,
		"checked_at": haTime(m.checked), "last_ok": haTime(m.lastOK), "error_since": haTime(m.errSince),
		"view": nil, "attention": m.attentionLocked(time.Now()),
	}
	if m.view != nil {
		out["view"] = m.view
	}
	return out
}

// names lists up to `limit` names and tells how many were left out.
func names(list []string, limit int) string {
	if len(list) <= limit {
		return strings.Join(list, ", ")
	}
	return fmt.Sprintf("%s и ещё %d", strings.Join(list[:limit], ", "), len(list)-limit)
}

func haLevel(b haBattery) string {
	if b.Level == nil {
		return "(разряжена)"
	}
	return fmt.Sprintf("%.0f %%", *b.Level)
}

func (m *haMonitor) attention(now time.Time) []response {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.attentionLocked(now)
}

func (m *haMonitor) attentionLocked(now time.Time) []response {
	items := []response{}
	add := func(id, severity, text, page string, since time.Time) {
		item := response{"id": id, "severity": severity, "text": text, "action": response{"label": "Открыть", "page": page}}
		if !since.IsZero() {
			item["since"] = since.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	if m.loadErr != "" {
		add("config", "warning", m.loadErr, "hasettings", time.Time{})
		return items
	}
	if !m.configured() {
		return items
	}
	if m.err != "" {
		if m.authErr {
			add("auth", "warning", "Home Assistant: "+m.err+" — обновите токен на странице «Настройка»", "hasettings", m.errSince)
		} else {
			add("offline", "critical", "Home Assistant не отвечает: "+m.err, "ha", m.errSince)
		}
		return items
	}
	if m.view == nil {
		return items
	}
	v := m.view
	if v.bridgeDown(now) {
		text := "Zigbee2MQTT: мост не на связи"
		if v.ZigbeeDown > 0 {
			text += fmt.Sprintf(", недоступно %d %s Zigbee", v.ZigbeeDown, plural(v.ZigbeeDown, "устройство", "устройства", "устройств"))
		}
		add("zigbee-bridge", "critical", text, "ha", v.Bridge.Since)
	}
	if n := len(v.Offline); n > 0 {
		what := "устройств"
		if !v.ByDevice {
			what = "сущностей"
		}
		if n <= haAttentionDetail {
			for _, d := range v.Offline {
				text := fmt.Sprintf("%s не на связи", d.Name)
				if d.Area != "" {
					text = fmt.Sprintf("%s (%s) не на связи", d.Name, d.Area)
				}
				add("offline-"+haSlug(d.Name), "warning", text, "ha", d.Since)
			}
		} else {
			list := []string{}
			for _, d := range v.Offline {
				list = append(list, d.Name)
			}
			add("offline-devices", "warning", fmt.Sprintf("Не на связи %d %s: %s", n, what, names(list, 4)), "ha", v.Offline[0].Since)
		}
	}
	if low := v.lowBatteries(); len(low) > 0 {
		list := []string{}
		for _, b := range low {
			list = append(list, b.Name+" "+haLevel(b))
		}
		add("batteries", "warning", fmt.Sprintf("Батарейки ниже %.0f %%: %s", haBatteryLow, names(list, 4)), "ha", time.Time{})
	}
	if v.Backup != nil {
		switch {
		case v.Backup.Last == nil:
			add("backup", "warning", "Автоматических резервных копий HA ещё не было", "ha", time.Time{})
		case now.Sub(*v.Backup.Last) > haBackupMaxAge:
			add("backup", "warning", fmt.Sprintf("Последняя резервная копия HA — %s назад", haAge(now.Sub(*v.Backup.Last))), "ha", *v.Backup.Last)
		}
	}
	if n := len(v.Updates); n > 0 {
		list := []string{}
		for _, u := range v.Updates {
			list = append(list, u.Name)
		}
		add("updates", "info", fmt.Sprintf("Доступно %d %s: %s", n, plural(n, "обновление", "обновления", "обновлений"), names(list, 4)), "ha", time.Time{})
	}
	sort.SliceStable(items, func(i, j int) bool { return haRank(items[i]) < haRank(items[j]) })
	return items
}

func haRank(item response) int {
	switch item["severity"] {
	case "critical":
		return 0
	case "warning":
		return 1
	}
	return 2
}

func haAge(d time.Duration) string {
	switch {
	case d < 2*time.Hour:
		return fmt.Sprintf("%d мин", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d ч", int(d.Hours()))
	}
	n := int(d.Hours() / 24)
	return fmt.Sprintf("%d %s", n, plural(n, "день", "дня", "дней"))
}

// haSlug keeps attention ids stable and inside [a-z0-9-] for any device name.
func haSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" || len(out) < len([]rune(s))/2 {
		// mostly non-Latin: a short stable hash
		var h uint32 = 2166136261
		for _, c := range []byte(s) {
			h = (h ^ uint32(c)) * 16777619
		}
		return strconv.FormatUint(uint64(h), 36)
	}
	return out
}

func (m *haMonitor) widgetHome(now time.Time) response {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.configured() {
		return response{"state": "unknown", "note": "Укажите адрес и токен на странице «Настройка»", "body": response{"label": "Home Assistant не настроен", "items": []response{}}}
	}
	if m.view == nil {
		label := "Нет данных от Home Assistant"
		if m.err != "" {
			label = "Нет связи: " + m.err
		}
		return response{"state": "bad", "updated_at": "", "body": response{"label": label, "items": []response{}}}
	}
	v := m.view
	items := []response{}
	unit := "Устройства"
	if !v.ByDevice {
		unit = "Сущности"
	}
	items = append(items, response{"text": fmt.Sprintf("%s на связи: %d из %d", unit, v.Online, v.Total), "ok": len(v.Offline) == 0 && v.ZigbeeDown == 0})
	if v.Bridge != nil {
		text := "Zigbee2MQTT: мост на связи"
		if !v.Bridge.Online {
			text = "Zigbee2MQTT: мост не на связи"
		}
		items = append(items, response{"text": text, "ok": v.Bridge.Online})
	}
	if n := len(v.Lights); n == 0 {
		items = append(items, response{"text": "Свет выключен везде", "ok": true})
	} else {
		list := []string{}
		for _, l := range v.Lights {
			list = append(list, l.Name)
		}
		items = append(items, response{"text": fmt.Sprintf("Свет включён: %s", names(list, 3)), "ok": true})
	}
	if low := v.lowBatteries(); len(low) > 0 {
		items = append(items, response{"text": fmt.Sprintf("Батарейки: %d ниже %.0f %%", len(low), haBatteryLow), "ok": false})
	} else if len(v.Batteries) > 0 {
		items = append(items, response{"text": fmt.Sprintf("Батарейки в норме: %d", len(v.Batteries)), "ok": true})
	}
	if n := len(v.Updates); n > 0 {
		items = append(items, response{"text": fmt.Sprintf("Доступно %d %s", n, plural(n, "обновление", "обновления", "обновлений")), "ok": false})
	} else {
		items = append(items, response{"text": "Обновлений нет", "ok": true})
	}
	if v.Backup != nil {
		if v.Backup.Last == nil {
			items = append(items, response{"text": "Резервных копий нет", "ok": false})
		} else {
			age := now.Sub(*v.Backup.Last)
			items = append(items, response{"text": "Резервная копия: " + haAge(age) + " назад", "ok": age <= haBackupMaxAge})
		}
	}
	state := "ok"
	attention := m.attentionLocked(now)
	for _, item := range attention {
		switch item["severity"] {
		case "critical":
			state = "bad"
		case "warning":
			state = worseState(state, "warn")
		}
	}
	if m.err != "" {
		state = "bad"
	}
	// the headline says what is wrong first; the version goes to the note
	label := "Всё в порядке"
	switch down := len(v.Offline) + v.ZigbeeDown; {
	case m.err != "":
		label = "Нет связи с HA, данные от " + m.lastOK.Local().Format("15:04")
	case v.bridgeDown(now):
		label = "Zigbee2MQTT не на связи"
	case down > 0:
		label = fmt.Sprintf("Не на связи: %d %s", down, plural(down, "устройство", "устройства", "устройств"))
		if !v.ByDevice {
			label = fmt.Sprintf("Не на связи: %d %s", down, plural(down, "сущность", "сущности", "сущностей"))
		}
	case len(attention) > 0:
		label = "Есть замечания"
	}
	note := "HA " + m.info.Version
	if m.info.Version == "" {
		note = ""
	}
	if m.info.LocationName != "" {
		note = strings.TrimPrefix(note+" · "+m.info.LocationName, " · ")
	}
	if link := m.link(); link != "" {
		if u, err := url.Parse(link); err == nil && u.Host != "" {
			note = strings.TrimPrefix(strings.Join([]string{note, u.Host}, " · "), " · ")
		}
	}
	return response{"state": state, "updated_at": haTime(m.lastOK), "note": note, "body": response{"label": label, "items": items}}
}
