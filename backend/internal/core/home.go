package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

// Home page built from module widgets (docs/modular-homenet/widgets.md).
// One browser request gathers every visible widget, attention and task list:
// modules are asked in parallel, each within its own budget, and the last good
// answer is served with stale=true when a module is slow, down or updating.

// a module's whole share of one home request; a variable for tests
var homeModuleBudget = 2 * time.Second

const (
	homeWidgetLimit  = 16 << 10
	homeSummaryLimit = 32 << 10
	homeSummaryTTL   = 15 * time.Second
	homeLayoutMax    = 48
	homeSimpleMax    = 6
)

type homeEntry struct {
	body    json.RawMessage
	ok      time.Time // when the module last answered well
	err     string
	errTime time.Time
}

type homeCache struct {
	mu      sync.Mutex
	entries map[string]*homeEntry
	layouts sync.Mutex
}

type HomeWidget struct {
	Key        string         `json:"key"`
	Module     string         `json:"module"`
	ModuleName string         `json:"module_name"`
	Version    string         `json:"version"`
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Kind       string         `json:"kind"`
	Sizes      []string       `json:"sizes"`
	Modes      []string       `json:"modes"`
	Page       string         `json:"page,omitempty"`
	Data       string         `json:"data,omitempty"`
	Default    map[string]int `json:"default,omitempty"`
	Refresh    int            `json:"refresh"`
}

type HomeData struct {
	State       string          `json:"state"`
	UpdatedAt   string          `json:"updated_at,omitempty"`
	Note        string          `json:"note,omitempty"`
	Body        json.RawMessage `json:"body,omitempty"`
	FetchedAt   *time.Time      `json:"fetched_at,omitempty"`
	Stale       bool            `json:"stale,omitempty"`
	Error       string          `json:"error,omitempty"`
	Unavailable string          `json:"unavailable,omitempty"`
}

type HomeAction struct {
	Label string `json:"label"`
	Page  string `json:"page"`
}

type HomeAttention struct {
	Module     string      `json:"module"`
	ModuleName string      `json:"module_name"`
	ID         string      `json:"id"`
	Severity   string      `json:"severity"`
	Text       string      `json:"text"`
	Since      string      `json:"since,omitempty"`
	Action     *HomeAction `json:"action,omitempty"`
	Stale      bool        `json:"stale,omitempty"`
}

type HomeTask struct {
	Module     string  `json:"module"`
	ModuleName string  `json:"module_name"`
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Value      float64 `json:"value,omitempty"`
	Total      float64 `json:"total,omitempty"`
	Step       string  `json:"step,omitempty"`
	EtaS       int     `json:"eta_s,omitempty"`
	Cancel     string  `json:"cancel,omitempty"`
	Note       string  `json:"note,omitempty"`
	Stale      bool    `json:"stale,omitempty"`
}

type HomeModule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	UIAPI   int    `json:"ui_api"`
	Enabled bool   `json:"enabled"`
	Page    string `json:"page,omitempty"`
	// ok, stale (a request failed, older data shown), updating, disabled
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type LayoutItem struct {
	W    string `json:"w"`
	Size string `json:"size"`
}

type layoutFile struct {
	V      int          `json:"v"`
	Pro    []LayoutItem `json:"pro"`
	Simple []LayoutItem `json:"simple"`
}

func (s *Server) homeState() *homeCache {
	s.homeOnce.Do(func() { s.homeCache = &homeCache{entries: map[string]*homeEntry{}} })
	return s.homeCache
}

var safeLogin = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._@-]{0,63}$`)

// layoutPath keeps one file per Account login; anything unusual is hashed so a
// login can never name a path outside the layouts directory.
func (s *Server) layoutPath(login string) string {
	name := login
	if !safeLogin.MatchString(login) || strings.Contains(login, "..") {
		h := sha256.Sum256([]byte(login))
		name = "h-" + hex.EncodeToString(h[:12])
	}
	return filepath.Join(s.Config.StateDir, "layouts", name+".json")
}

func (s *Server) readLayout(login string) layoutFile {
	var l layoutFile
	if login == "" {
		return l
	}
	b, err := os.ReadFile(s.layoutPath(login))
	if err != nil || json.Unmarshal(b, &l) != nil || l.V != 1 {
		return layoutFile{}
	}
	return l
}

func (l layoutFile) mode(mode string) []LayoutItem {
	if mode == "simple" {
		return l.Simple
	}
	return l.Pro
}

// homeCatalog lists the widgets of installed ui_api 2 modules.
func homeCatalog(items []integration.Installed) map[string]HomeWidget {
	out := map[string]HomeWidget{}
	for _, item := range items {
		m := item.Manifest
		for _, w := range m.UI.Widgets {
			key := m.ID + "/" + w.ID
			out[key] = HomeWidget{Key: key, Module: m.ID, ModuleName: m.Name, Version: m.Version, ID: w.ID, Title: w.Title, Kind: w.Kind,
				Sizes: w.Sizes, Modes: w.Modes, Page: w.Page, Data: w.Data, Default: w.Default, Refresh: w.RefreshSeconds()}
		}
	}
	return out
}

func hasString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// defaultLayout: every enabled module's widgets that name an order for the mode.
func defaultLayout(catalog map[string]HomeWidget, enabled map[string]bool, mode string) []LayoutItem {
	list := []HomeWidget{}
	for _, w := range catalog {
		if _, ok := w.Default[mode]; ok && enabled[w.Module] && hasString(w.Modes, mode) {
			list = append(list, w)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.Default[mode] != b.Default[mode] {
			return a.Default[mode] < b.Default[mode]
		}
		return a.Key < b.Key
	})
	out := []LayoutItem{}
	for _, w := range list {
		if mode == "simple" && len(out) == homeSimpleMax {
			break
		}
		out = append(out, LayoutItem{W: w.Key, Size: w.Sizes[0]})
	}
	return out
}

// effectiveLayout drops widgets of removed modules silently and fixes sizes a
// new module version no longer offers.
func effectiveLayout(saved []LayoutItem, catalog map[string]HomeWidget, mode string) []LayoutItem {
	out := []LayoutItem{}
	for _, item := range saved {
		w, ok := catalog[item.W]
		if !ok || !hasString(w.Modes, mode) {
			continue
		}
		if !hasString(w.Sizes, item.Size) {
			item.Size = w.Sizes[0]
		}
		out = append(out, item)
	}
	return out
}

func validateLayout(items []LayoutItem, catalog map[string]HomeWidget, mode string) error {
	if len(items) > homeLayoutMax {
		return fmt.Errorf("слишком много виджетов")
	}
	seen := map[string]bool{}
	for _, item := range items {
		w, ok := catalog[item.W]
		if !ok {
			return fmt.Errorf("неизвестный виджет %q", item.W)
		}
		if seen[item.W] {
			return fmt.Errorf("виджет %q указан дважды", item.W)
		}
		seen[item.W] = true
		if !hasString(w.Modes, mode) {
			return fmt.Errorf("виджет %q недоступен в этом режиме", item.W)
		}
		if !hasString(w.Sizes, item.Size) {
			return fmt.Errorf("у виджета %q нет размера %q", item.W, item.Size)
		}
	}
	return nil
}

// updatingModules: modules an unfinished Core operation is switching now.
func (s *Server) updatingModules() (map[string]bool, []integration.Operation) {
	busy := map[string]bool{}
	ops, err := s.Lifecycle.History()
	if err != nil {
		return busy, nil
	}
	active := []integration.Operation{}
	for _, op := range ops {
		switch op.Status {
		case "running", "recovering", "recovery_required":
			active = append(active, op)
			for _, c := range op.Changes {
				busy[c.ID] = true
			}
		}
	}
	return busy, active
}

// fetch returns a module answer no older than maxAge, asking the module when
// the cached one is older. A failure keeps the previous answer, marked stale.
func (s *Server) homeFetch(ctx context.Context, item integration.Installed, path string, maxAge time.Duration, limit int64) (json.RawMessage, *time.Time, bool, string) {
	c := s.homeState()
	key := item.Manifest.ID + "@" + item.Manifest.Version + path
	now := time.Now()
	c.mu.Lock()
	e := c.entries[key]
	if e != nil && e.body != nil && now.Sub(e.ok) < maxAge {
		at := e.ok
		c.mu.Unlock()
		return e.body, &at, false, ""
	}
	c.mu.Unlock()
	body, err := s.homeRequest(ctx, item, path, limit)
	c.mu.Lock()
	defer c.mu.Unlock()
	e = c.entries[key]
	if e == nil {
		e = &homeEntry{}
		c.entries[key] = e
	}
	if err == nil {
		e.body, e.ok, e.err = body, now, ""
		at := e.ok
		return body, &at, false, ""
	}
	e.err, e.errTime = err.Error(), now
	if e.body != nil {
		at := e.ok
		return e.body, &at, true, e.err
	}
	return nil, nil, true, e.err
}

// homeCached returns the last good answer of any version without asking the
// module: the data of a version being replaced is still worth showing grey.
func (s *Server) homeCached(item integration.Installed, path string) (json.RawMessage, *time.Time) {
	c := s.homeState()
	c.mu.Lock()
	defer c.mu.Unlock()
	prefix := item.Manifest.ID + "@"
	var best *homeEntry
	for k, e := range c.entries {
		rest, ok := strings.CutPrefix(k, prefix)
		i := strings.Index(rest, "/")
		if !ok || i < 1 || rest[i:] != path || e.body == nil {
			continue
		}
		if best == nil || e.ok.After(best.ok) {
			best = e
		}
	}
	if best == nil {
		return nil, nil
	}
	at := best.ok
	return best.body, &at
}

func (s *Server) homeRequest(ctx context.Context, item integration.Installed, path string, limit int64) (json.RawMessage, error) {
	m := item.Manifest
	// checked again on every request: Core never forwards outside the module's paths
	if !m.Allows(path) {
		return nil, fmt.Errorf("путь вне разрешённых модулю")
	}
	token, err := s.workerToken(m.ID)
	if err != nil {
		return nil, fmt.Errorf("нет ключа модуля")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimSuffix(m.Backend.Endpoint, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	res, err := s.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("не ответил за %d с", int(homeModuleBudget.Seconds()))
		}
		return nil, fmt.Errorf("нет связи с модулем")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("модуль ответил %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("обрыв ответа модуля")
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("ответ больше %d КБ", limit>>10)
	}
	if !json.Valid(b) {
		return nil, fmt.Errorf("ответ не JSON")
	}
	return b, nil
}

func clip(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return string(r)
}

func widgetData(raw json.RawMessage) HomeData {
	var d struct {
		State     string          `json:"state"`
		UpdatedAt string          `json:"updated_at"`
		Note      string          `json:"note"`
		Body      json.RawMessage `json:"body"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return HomeData{State: "unknown", Error: "данные виджета не разобрать"}
	}
	switch d.State {
	case "ok", "warn", "bad", "unknown":
	default:
		d.State = "unknown"
	}
	return HomeData{State: d.State, UpdatedAt: clip(d.UpdatedAt, 40), Note: clip(d.Note, 160), Body: d.Body}
}

var severityRank = map[string]int{"critical": 0, "warning": 1, "info": 2}

var pagePart = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,48}$`)

func validPage(p string) bool {
	if p == "" || len(p) > 96 {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if !pagePart.MatchString(part) || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func parseAttention(raw json.RawMessage, m integration.Manifest, stale bool) []HomeAttention {
	var body struct {
		Items []HomeAttention `json:"items"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	out := []HomeAttention{}
	for _, a := range body.Items {
		if len(out) == 20 {
			break
		}
		if _, ok := severityRank[a.Severity]; !ok || strings.TrimSpace(a.Text) == "" {
			continue
		}
		a.Module, a.ModuleName, a.Stale = m.ID, m.Name, stale
		a.ID, a.Text, a.Since = clip(a.ID, 64), clip(a.Text, 200), clip(a.Since, 40)
		if a.Action != nil {
			a.Action.Label = clip(a.Action.Label, 32)
			if !validPage(a.Action.Page) || a.Action.Label == "" {
				a.Action = nil
			}
		}
		out = append(out, a)
	}
	return out
}

func parseTasks(raw json.RawMessage, m integration.Manifest, stale bool) []HomeTask {
	var body struct {
		Items []HomeTask `json:"items"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	out := []HomeTask{}
	for _, t := range body.Items {
		if len(out) == 10 {
			break
		}
		if strings.TrimSpace(t.Label) == "" || t.Value < 0 || t.Total < 0 {
			continue
		}
		t.Module, t.ModuleName, t.Stale = m.ID, m.Name, stale
		t.ID, t.Label, t.Step, t.Note = clip(t.ID, 64), clip(t.Label, 80), clip(t.Step, 60), clip(t.Note, 120)
		if t.Cancel != "" && !m.Allows(t.Cancel) {
			t.Cancel = ""
		}
		out = append(out, t)
	}
	return out
}

var actionLabel = map[string]string{"install": "Установка", "update": "Обновление", "rollback": "Откат", "enable": "Включение", "disable": "Отключение", "remove": "Удаление"}
var stepIndex = map[string]float64{"validated": 0, "stopping": 1, "starting": 2, "committing": 3, "complete": 4}
var stepText = map[string]string{"stopping": "остановка", "starting": "запуск и проверка", "committing": "запись", "rolling_back": "возврат прежней версии"}

// coreTasks: Core's own work — module operations — next to the modules' tasks.
func coreTasks(ops []integration.Operation, names map[string]string) ([]HomeTask, []HomeAttention) {
	tasks, attention := []HomeTask{}, []HomeAttention{}
	for _, op := range ops {
		if op.Status == "recovery_required" {
			attention = append(attention, HomeAttention{Module: "core", ModuleName: "Core", ID: "operation-" + op.ID, Severity: "critical",
				Text: "Операция с интеграциями прервана и требует восстановления", Action: &HomeAction{Label: "Открыть", Page: "integrations"}})
			continue
		}
		parts := []string{}
		for _, c := range op.Changes {
			label := actionLabel[c.Action]
			if label == "" {
				label = c.Action
			}
			name := names[c.ID]
			if name == "" {
				name = c.ID
			}
			from := ""
			for _, b := range op.Before {
				if b.Manifest.ID == c.ID {
					from = b.Manifest.Version
				}
			}
			text := label + " «" + name + "»"
			if c.Version != "" && from != "" && from != c.Version {
				text += " " + from + " → " + c.Version
			} else if c.Version != "" {
				text += " " + c.Version
			}
			parts = append(parts, text)
		}
		step := stepText[op.Step]
		if op.Status == "recovering" {
			step = "восстановление прежнего набора"
		}
		tasks = append(tasks, HomeTask{Module: "core", ModuleName: "Core", ID: op.ID, Label: clip(strings.Join(parts, ", "), 80),
			Value: stepIndex[op.Step], Total: 4, Step: step, Note: "при ошибке вернётся прежняя версия автоматически"})
	}
	return tasks, attention
}

func (s *Server) home(w http.ResponseWriter, r *http.Request, id Identity) {
	switch {
	case r.URL.Path == "/api/platform/home" && r.Method == "GET":
		s.homeGet(w, r, id)
	case r.URL.Path == "/api/platform/home/layout" && (r.Method == "PUT" || r.Method == "DELETE"):
		s.homeLayout(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func homeMode(r *http.Request) string {
	if r.URL.Query().Get("mode") == "simple" {
		return "simple"
	}
	return "pro"
}

func (s *Server) homeLayout(w http.ResponseWriter, r *http.Request, id Identity) {
	if id.Login == "" {
		jsonReply(w, 400, map[string]string{"error": "раскладка сохраняется только для входа с именем"})
		return
	}
	mode := homeMode(r)
	var items []LayoutItem
	if r.Method == "PUT" {
		var req struct {
			Mode  string       `json:"mode"`
			Items []LayoutItem `json:"items"`
		}
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		d.DisallowUnknownFields()
		if err := d.Decode(&req); err != nil || !integration.HomeModes[req.Mode] || req.Items == nil {
			jsonReply(w, 400, map[string]string{"error": "неверная раскладка"})
			return
		}
		mode, items = req.Mode, req.Items
		if err := validateLayout(items, homeCatalog(s.Registry.Snapshot()), mode); err != nil {
			jsonReply(w, 400, map[string]string{"error": err.Error()})
			return
		}
	}
	c := s.homeState()
	c.layouts.Lock()
	defer c.layouts.Unlock()
	l := s.readLayout(id.Login)
	l.V = 1
	if mode == "simple" {
		l.Simple = items
	} else {
		l.Pro = items
	}
	file := s.layoutPath(id.Login)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		jsonReply(w, 503, map[string]string{"error": "раскладку не сохранить"})
		return
	}
	if err := integration.AtomicJSON(file, l); err != nil {
		jsonReply(w, 503, map[string]string{"error": "раскладку не сохранить"})
		return
	}
	jsonReply(w, 200, map[string]any{"ok": true, "mode": mode, "customized": items != nil})
}

func (s *Server) homeGet(w http.ResponseWriter, r *http.Request, id Identity) {
	mode := homeMode(r)
	items := s.Registry.Snapshot()
	catalog := homeCatalog(items)
	busy, ops := s.updatingModules()
	enabled, names := map[string]bool{}, map[string]string{}
	for _, it := range items {
		enabled[it.Manifest.ID] = it.Enabled
		names[it.Manifest.ID] = it.Manifest.Name
	}
	saved := s.readLayout(id.Login).mode(mode)
	customized := saved != nil
	layout := defaultLayout(catalog, enabled, mode)
	if customized {
		layout = effectiveLayout(saved, catalog, mode)
	}
	visible := map[string][]HomeWidget{}
	for _, item := range layout {
		w := catalog[item.W]
		visible[w.Module] = append(visible[w.Module], w)
	}

	var mu sync.Mutex
	data := map[string]HomeData{}
	attention, tasks := []HomeAttention{}, []HomeTask{}
	modules := make([]HomeModule, 0, len(items))
	asked := []int{}
	for n, it := range items {
		m := it.Manifest
		hm := HomeModule{ID: m.ID, Name: m.Name, Version: m.Version, UIAPI: m.UIAPI, Enabled: it.Enabled, State: "ok"}
		if len(m.UI.Pages) > 0 {
			hm.Page = m.UI.Pages[0].ID
		}
		reason := ""
		switch {
		case busy[m.ID]:
			hm.State, reason = "updating", "обновляется"
		case !it.Enabled:
			hm.State, reason = "disabled", "выключен"
		}
		hm.Reason = reason
		if reason != "" {
			// last data grey, nothing asked from a module being switched or turned off
			for _, w := range visible[m.ID] {
				d := HomeData{State: "unknown", Unavailable: reason}
				if w.Kind != "custom" {
					if raw, at := s.homeCached(it, w.Data); raw != nil {
						d = widgetData(raw)
						d.FetchedAt, d.Stale, d.Unavailable = at, true, reason
					}
				}
				data[w.Key] = d
			}
			modules = append(modules, hm)
			continue
		}
		if m.UIAPI < 2 {
			modules = append(modules, hm)
			continue
		}
		asked = append(asked, n)
		modules = append(modules, hm)
	}
	var wg sync.WaitGroup
	for _, n := range asked {
		it, idx := items[n], n
		wg.Add(1)
		go func(it integration.Installed, idx int) {
			defer wg.Done()
			m := it.Manifest
			ctx, cancel := context.WithTimeout(r.Context(), homeModuleBudget)
			defer cancel()
			var inner sync.WaitGroup
			failed, oldest := "", (*time.Time)(nil)
			note := func(stale bool, err string, at *time.Time) {
				if stale {
					mu.Lock()
					if failed == "" {
						failed = err
					}
					if at != nil && (oldest == nil || at.Before(*oldest)) {
						oldest = at
					}
					mu.Unlock()
				}
			}
			for _, w := range visible[m.ID] {
				if w.Kind == "custom" {
					mu.Lock()
					data[w.Key] = HomeData{State: "unknown"}
					mu.Unlock()
					continue
				}
				inner.Add(1)
				go func(w HomeWidget) {
					defer inner.Done()
					raw, at, stale, err := s.homeFetch(ctx, it, w.Data, time.Duration(w.Refresh)*time.Second, homeWidgetLimit)
					d := HomeData{State: "unknown", Error: err}
					if raw != nil {
						d = widgetData(raw)
						d.FetchedAt, d.Stale = at, stale
						if stale {
							d.Error = err
						}
					}
					note(stale, err, at)
					mu.Lock()
					data[w.Key] = d
					mu.Unlock()
				}(w)
			}
			if sm := m.UI.Summary; sm != nil {
				for _, p := range []struct {
					path  string
					tasks bool
				}{{sm.Attention, false}, {sm.Tasks, true}} {
					if p.path == "" {
						continue
					}
					inner.Add(1)
					go func(path string, isTasks bool) {
						defer inner.Done()
						raw, at, stale, err := s.homeFetch(ctx, it, path, homeSummaryTTL, homeSummaryLimit)
						note(stale, err, at)
						if raw == nil {
							return
						}
						mu.Lock()
						defer mu.Unlock()
						if isTasks {
							if !stale {
								// a stale task list says nothing true about now
								tasks = append(tasks, parseTasks(raw, m, false)...)
							}
						} else {
							attention = append(attention, parseAttention(raw, m, stale)...)
						}
					}(p.path, p.tasks)
				}
			}
			inner.Wait()
			mu.Lock()
			defer mu.Unlock()
			if failed != "" {
				modules[idx].State, modules[idx].Reason = "stale", failed
				text := "«" + m.Name + "»: " + failed
				if oldest != nil {
					text += " — показаны данные " + oldest.Local().Format("15:04")
				}
				attention = append(attention, HomeAttention{Module: m.ID, ModuleName: m.Name, ID: "core-unreachable", Severity: "warning", Text: text})
			}
		}(it, idx)
	}
	wg.Wait()

	ct, ca := coreTasks(ops, names)
	tasks = append(ct, tasks...)
	attention = append(attention, ca...)
	sort.SliceStable(attention, func(i, j int) bool {
		a, b := attention[i], attention[j]
		if severityRank[a.Severity] != severityRank[b.Severity] {
			return severityRank[a.Severity] < severityRank[b.Severity]
		}
		return a.Since < b.Since
	})
	list := make([]HomeWidget, 0, len(catalog))
	for _, w := range catalog {
		if enabled[w.Module] {
			list = append(list, w)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Key < list[j].Key })
	jsonReply(w, 200, map[string]any{
		"mode": mode, "generated_at": time.Now().UTC(), "customized": customized, "layout": layout,
		"catalog": list, "data": data, "attention": attention, "tasks": tasks, "modules": modules,
		"can_save": id.Login != "",
	})
}
