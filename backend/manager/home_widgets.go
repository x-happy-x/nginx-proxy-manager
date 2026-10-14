package main

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

/*
 * Widgets for Core's home page (NPM-66, docs/modular-homenet/widgets.md).
 * Each answer is built from what the background collectors already hold —
 * service checks, the adaptive health history, bypass traffic, OLCRTC checks —
 * so opening the home page never starts a probe. The only live request is the
 * channel's mode, one local GET /network to the core.
 */

type widgetReply struct {
	State     string `json:"state"`
	UpdatedAt string `json:"updated_at,omitempty"`
	Note      string `json:"note,omitempty"`
	Body      any    `json:"body"`
}

type widgetItem struct {
	Text  string `json:"text"`
	OK    *bool  `json:"ok,omitempty"`
	State string `json:"state,omitempty"`
	Value string `json:"value,omitempty"`
	Page  string `json:"page,omitempty"`
}

type attentionItem struct {
	ID       string            `json:"id"`
	Severity string            `json:"severity"`
	Text     string            `json:"text"`
	Since    string            `json:"since,omitempty"`
	Action   map[string]string `json:"action,omitempty"`
}

type taskItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Value int    `json:"value,omitempty"`
	Total int    `json:"total,omitempty"`
	Step  string `json:"step,omitempty"`
}

var channelLabel = map[string]string{"normal": "Обычный", "whitelist": "Белые списки", "offline": "Нет интернета", "unknown": "Не определён"}
var channelWidgetState = map[string]string{"normal": "ok", "whitelist": "warn", "offline": "bad", "unknown": "unknown"}

func boolp(v bool) *bool { return &v }

func stamp(unix int64) string {
	if unix <= 0 {
		return ""
	}
	return time.Unix(unix, 0).UTC().Format(time.RFC3339)
}

// lastResult: the newest check of a service, if it ever ran.
func lastResult(s serviceState) (serviceResult, bool) {
	if len(s.History) == 0 {
		return serviceResult{}, false
	}
	return s.History[len(s.History)-1], true
}

// failingSince: when the current run of failures began.
func failingSince(s serviceState) int64 {
	since := int64(0)
	for i := len(s.History) - 1; i >= 0 && !s.History[i].OK; i-- {
		since = s.History[i].T
	}
	return since
}

func serviceSnapshot() (int64, []serviceState) {
	if services == nil {
		return 0, nil
	}
	return services.snapshot()
}

func (a *app) widgetChannel() widgetReply {
	ch := channelNow(nil)
	st := widgetReply{State: channelWidgetState[ch.Mode], UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	if st.State == "" {
		st.State = "unknown"
	}
	label := channelLabel[ch.Mode]
	if label == "" {
		label = ch.Mode
	}
	if t, err := time.Parse(time.RFC3339Nano, ch.Since); err == nil && !t.IsZero() {
		st.Note = "с " + t.Local().Format("15:04")
		if time.Since(t) > 24*time.Hour {
			st.Note = "с " + t.Local().Format("02.01 15:04")
		}
	}
	if ch.Error != "" {
		st.Note = ch.Error
	}
	items := []widgetItem{}
	_, list := serviceSnapshot()
	for _, s := range list {
		if s.ID != "ru" && s.ID != "google" {
			continue
		}
		if r, ok := lastResult(s); ok {
			name := map[string]string{"ru": "Яндекс", "google": "Google"}[s.ID]
			items = append(items, widgetItem{Text: name, OK: boolp(r.OK)})
		}
	}
	st.Body = map[string]any{"label": label, "items": items}
	return st
}

func (a *app) widgetServices() widgetReply {
	checked, list := serviceSnapshot()
	if services == nil {
		return widgetReply{State: "unknown", Note: "проверка сервисов выключена", Body: map[string]any{"value": "—"}}
	}
	ok, total, down := 0, 0, []string{}
	for _, s := range list {
		r, has := lastResult(s)
		if !has {
			continue
		}
		total++
		if r.OK {
			ok++
		} else {
			down = append(down, s.Name)
		}
	}
	st := widgetReply{State: "ok", UpdatedAt: stamp(checked), Note: "все открываются"}
	switch {
	case total == 0:
		st.State, st.Note = "unknown", "ещё не проверялись"
	case len(down) > total/2:
		st.State = "bad"
	case len(down) > 0:
		st.State = "warn"
	}
	if len(down) > 0 {
		st.Note = "не открывается: " + strings.Join(down, ", ")
	}
	st.Body = map[string]any{"value": fmt.Sprintf("%d из %d", ok, total)}
	return st
}

func (a *app) widgetServers() widgetReply {
	if traffic == nil {
		return widgetReply{State: "unknown", Note: "учёт на роутере не запущен", Body: map[string]any{"points": []any{}}}
	}
	now := time.Now()
	rep := traffic.healthReport("", "24h", now)
	series, _ := rep["series"].([]healthPoint)
	provider, _ := rep["provider"].(string)
	points := [][2]any{}
	bands := []map[string]string{}
	var band map[string]string
	// five-minute steps: at most 288 points a day
	for i, p := range series {
		wl := p.Whitelist > 0
		if wl && band == nil {
			band = map[string]string{"from": stamp(p.T), "label": "белые списки"}
		}
		if !wl && band != nil {
			band["to"] = stamp(p.T)
			bands = append(bands, band)
			band = nil
		}
		if i%5 == 0 || i == len(series)-1 {
			points = append(points, [2]any{stamp(p.T), p.Working})
		}
	}
	if band != nil {
		band["to"] = stamp(now.Unix())
		bands = append(bands, band)
	}
	st := widgetReply{State: "unknown", Note: "нет истории проверок", Body: map[string]any{"unit": "серверов", "points": points, "bands": bands}}
	if n := len(series); n > 0 {
		last := series[n-1]
		st.UpdatedAt = stamp(last.T)
		stable := last.StableNormal
		if last.Whitelist > 0 {
			stable = last.StableWhitelist
		}
		st.Note = fmt.Sprintf("сейчас %d из %d · стабильных %d · %s", last.Working, last.Total, stable, provider)
		st.State = "ok"
		if last.Working == 0 {
			st.State = "bad"
		} else if stable == 0 {
			st.State = "warn"
		}
	}
	return st
}

// widgetReliability: how often each server works, as a distribution — most
// subscriptions are hundreds of nodes, so the shape says more than a list.
func (a *app) widgetReliability() widgetReply {
	if traffic == nil {
		return widgetReply{State: "unknown", Note: "учёт на роутере не запущен", Body: map[string]any{"bars": []any{}}}
	}
	provider, shares := traffic.reliability(time.Now())
	bars := make([]map[string]any, 10)
	counts := make([]int, 10)
	reliable := 0
	for _, v := range shares {
		i := int(v * 10)
		if i > 9 {
			i = 9
		}
		counts[i]++
		if v >= 0.9 {
			reliable++
		}
	}
	for i := range bars {
		bars[i] = map[string]any{"label": fmt.Sprintf("%d–%d%%", i*10, i*10+10), "value": counts[i]}
	}
	body := map[string]any{"unit": "серверов", "bars": bars, "scale": "sqrt"}
	if len(shares) == 0 {
		return widgetReply{State: "unknown", Note: "история копится: нужно полчаса наблюдений", Body: body}
	}
	st := widgetReply{State: "ok", UpdatedAt: time.Now().UTC().Format(time.RFC3339), Body: body,
		Note: fmt.Sprintf("работают ≥90%% времени: %d из %d · %s", reliable, len(shares), provider)}
	switch {
	case reliable == 0:
		st.State = "bad"
	case reliable < 3:
		st.State = "warn"
	}
	return st
}

func gb(bytes int64) string {
	v := float64(bytes) / (1 << 30)
	s := strconv.FormatFloat(v, 'f', 1, 64)
	if v >= 100 {
		s = strconv.FormatFloat(v, 'f', 0, 64)
	}
	return strings.Replace(s, ".", ",", 1)
}

func (a *app) widgetTraffic() widgetReply {
	if traffic == nil {
		return widgetReply{State: "unknown", Note: "учёт трафика не запущен", Body: map[string]any{"value": "—"}}
	}
	rep := traffic.bypassReport("24h", time.Now())
	limit, _ := rep["limit"].(map[string]any)
	used, _ := limit["used"].(int64)
	max, _ := limit["gb"].(int)
	start, _ := limit["cycle_start"].(int64)
	st := widgetReply{State: "ok", UpdatedAt: time.Now().UTC().Format(time.RFC3339), Note: "лимит не задан"}
	if max > 0 {
		share := float64(used) / float64(int64(max)<<30)
		st.Note = fmt.Sprintf("%d%% лимита %d ГБ", int(share*100), max)
		if share >= 1 {
			st.State = "bad"
		} else if share >= 0.9 {
			st.State = "warn"
		}
	}
	if start > 0 {
		st.Note += " · с " + time.Unix(start, 0).Local().Format("02.01")
	}
	st.Body = map[string]any{"value": gb(used), "unit": "ГБ"}
	return st
}

type olcView struct {
	servers  int
	nodes    []widgetItem
	working  int
	checked  int64
	job      *olcJob
	selected string
}

func olcSnapshotView() (olcView, bool) {
	if olc == nil {
		return olcView{}, false
	}
	v := olcView{}
	olc.mu.Lock()
	defer olc.mu.Unlock()
	v.servers = len(olc.st.Servers)
	for _, s := range olc.st.Servers {
		for _, x := range s.Variants {
			c, ok := olc.st.Checks[x.Node]
			item := widgetItem{Text: x.Node, Page: "olcrtc"}
			if ok {
				item.OK = boolp(c.OK)
				if c.OK {
					v.working++
					item.Value = fmt.Sprintf("%d мс", c.MS)
				}
				if c.T > v.checked {
					v.checked = c.T
				}
			}
			v.nodes = append(v.nodes, item)
		}
	}
	if olc.job != nil && olc.job.Running {
		cp := *olc.job
		cp.Steps = append([]*olcStep(nil), olc.job.Steps...)
		v.job = &cp
	}
	return v, true
}

func (a *app) widgetOlcrtc() widgetReply {
	v, on := olcSnapshotView()
	if !on {
		return widgetReply{State: "unknown", Note: "OLCRTC не запущен", Body: map[string]any{"label": "—", "items": []widgetItem{}}}
	}
	if v.servers == 0 {
		return widgetReply{State: "unknown", Note: "резервный канал не настроен", Body: map[string]any{"label": "Не настроен", "items": []widgetItem{}}}
	}
	st := widgetReply{State: "ok", UpdatedAt: stamp(v.checked), Note: "резервный канал · UDP через реле"}
	switch {
	case len(v.nodes) == 0:
		st.State = "warn"
	case v.working == 0:
		st.State = "bad"
	case v.working < len(v.nodes):
		st.State = "warn"
	}
	if len(v.nodes) > 8 {
		v.nodes = v.nodes[:8]
	}
	st.Body = map[string]any{"label": fmt.Sprintf("%d из %d работают", v.working, len(v.nodes)), "items": v.nodes}
	return st
}

func (a *app) summaryAttention() []attentionItem {
	out := []attentionItem{}
	ch := channelNow(nil)
	switch {
	case ch.Mode == "offline":
		out = append(out, attentionItem{ID: "channel-offline", Severity: "critical", Text: "У провайдера нет интернета", Since: ch.Since, Action: map[string]string{"label": "Открыть", "page": "vpn"}})
	case ch.Mode == "unknown" && ch.Error != "":
		out = append(out, attentionItem{ID: "channel-unknown", Severity: "info", Text: "Режим канала не определён: " + ch.Error, Action: map[string]string{"label": "Открыть", "page": "vpn"}})
	}
	_, list := serviceSnapshot()
	down := 0
	for _, s := range list {
		if r, ok := lastResult(s); ok && !r.OK {
			down++
			text := "«" + s.Name + "» не открывается"
			if r.Error != "" {
				text += ": " + r.Error
			}
			out = append(out, attentionItem{ID: "service-" + s.ID, Severity: "warning", Text: text, Since: stamp(failingSince(s)), Action: map[string]string{"label": "Разобрать", "page": "vpnsvc"}})
		}
	}
	if total := len(list); total > 0 && down > total/2 {
		for i := range out {
			if strings.HasPrefix(out[i].ID, "service-") {
				out[i].Severity = "critical"
			}
		}
	}
	if v, on := olcSnapshotView(); on && len(v.nodes) > 0 && v.working == 0 && v.checked > 0 {
		out = append(out, attentionItem{ID: "olcrtc-down", Severity: "warning", Text: "OLCRTC: ни один узел не проходит проверку", Since: stamp(v.checked), Action: map[string]string{"label": "Открыть", "page": "olcrtc"}})
	}
	if w := a.widgetTraffic(); w.State == "bad" {
		out = append(out, attentionItem{ID: "traffic-limit", Severity: "warning", Text: "Трафик через обходы превысил лимит: " + w.Note, Action: map[string]string{"label": "Открыть", "page": "traffic"}})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Since < out[j].Since })
	return out
}

func (a *app) summaryTasks() []taskItem {
	out := []taskItem{}
	if v, on := olcSnapshotView(); on && v.job != nil {
		done, step := 0, ""
		for _, s := range v.job.Steps {
			switch s.Status {
			case "ok", "skip", "fail":
				done++
			case "run":
				if step == "" {
					step = s.Title
				}
			}
		}
		label := "OLCRTC: настройка сервера"
		if v.job.Kind == "repick" {
			label = "OLCRTC: подбор узлов"
		}
		if v.job.Waiting != "" {
			step = "ждёт решения на экране OLCRTC"
		}
		out = append(out, taskItem{ID: "olcrtc-" + v.job.ID, Label: label, Value: done, Total: len(v.job.Steps), Step: step})
	}
	snap := installer.snapshot()
	if running, _ := snap["running"].(bool); running {
		step, _ := snap["step"].(string)
		out = append(out, taskItem{ID: "core-install", Label: "Установка ядра mihomo", Step: step})
	}
	return out
}

// handleHomeWidget serves /api/core/widgets/<id> and /api/core/summary/<list>.
func (a *app) handleHomeWidget(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	if id, ok := strings.CutPrefix(path, "/api/core/widgets/"); ok {
		var reply widgetReply
		switch id {
		case "channel":
			reply = a.widgetChannel()
		case "services":
			reply = a.widgetServices()
		case "servers":
			reply = a.widgetServers()
		case "servers-reliability":
			reply = a.widgetReliability()
		case "traffic-month":
			reply = a.widgetTraffic()
		case "olcrtc":
			reply = a.widgetOlcrtc()
		default:
			http.NotFound(w, r)
			return true
		}
		a.writeJSON(w, http.StatusOK, reply)
		return true
	}
	switch path {
	case "/api/core/summary/attention":
		a.writeJSON(w, http.StatusOK, map[string]any{"items": a.summaryAttention()})
		return true
	case "/api/core/summary/tasks":
		a.writeJSON(w, http.StatusOK, map[string]any{"items": a.summaryTasks()})
		return true
	}
	return false
}
