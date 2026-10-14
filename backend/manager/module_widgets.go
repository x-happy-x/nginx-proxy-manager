package main

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

/*
 * Home widgets of Proxy and Network (NPM-67, docs/modular-homenet/widgets.md).
 * Like VPN's (home_widgets.go) they read what the background collectors hold —
 * the access-log telemetry, the network monitor's samples — and local files;
 * nothing here runs nginx, ss or a ping.
 */

// nginxRunning: the pid file and the process behind it, without nginx -T.
func (a *app) nginxRunning() bool {
	mainConf := getenv("NGINX_MAIN_CONF", filepath.Join(a.nginxConfRoot, "nginx.conf"))
	body, err := os.ReadFile(getenv("NGINX_PID", filepath.Join(a.nginxConfRoot, "nginx.pid")))
	if err != nil {
		return false
	}
	pid := strings.TrimSpace(string(body))
	if _, err := strconv.Atoi(pid); err != nil {
		return false
	}
	cmdline, err := os.ReadFile(filepath.Join("/proc", pid, "cmdline"))
	return err == nil && strings.Contains(string(cmdline), mainConf)
}

func (a *app) widgetDomains() widgetReply {
	routes, err := schema.LoadRoutes(a.routesPath())
	if err != nil {
		return widgetReply{State: "unknown", Note: "routes.yml не читается", Body: map[string]any{"value": "—"}}
	}
	st := widgetReply{State: "ok", UpdatedAt: time.Now().UTC().Format(time.RFC3339), Note: "nginx работает"}
	if !a.nginxRunning() {
		st.State, st.Note = "bad", "nginx остановлен — домены не открываются"
	}
	st.Body = map[string]any{"value": strconv.Itoa(len(routes.Hosts)), "unit": plural(len(routes.Hosts), "домен", "домена", "доменов")}
	return st
}

func plural(n int, one, few, many string) string {
	n %= 100
	if n >= 11 && n <= 14 {
		return many
	}
	switch n % 10 {
	case 1:
		return one
	case 2, 3, 4:
		return few
	}
	return many
}

type certInfo struct {
	host  string
	until time.Time
}

// certExpiry reads every certificate nginx serves: routes.yml's and the local CA's.
func (a *app) certExpiry() []certInfo {
	paths := map[string]string{}
	if routes, err := schema.LoadRoutes(a.routesPath()); err == nil {
		for _, c := range routes.Certs {
			if c.CRTPath != "" {
				paths[c.CRTPath] = c.Host
			}
		}
	}
	dir := filepath.Join(a.nginxConfRoot, "selfsigned")
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".crt") && e.Name() != "stub.crt" {
				paths[filepath.Join(dir, e.Name())] = strings.TrimSuffix(e.Name(), ".crt")
			}
		}
	}
	out := []certInfo{}
	for p, host := range paths {
		body, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		block, _ := pem.Decode(body)
		if block == nil {
			continue
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		if host == "" {
			host = c.Subject.CommonName
		}
		out = append(out, certInfo{host: host, until: c.NotAfter})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].until.Before(out[j].until) })
	return out
}

const certWarnDays = 14

func certDays(until, now time.Time) int { return int(until.Sub(now).Hours() / 24) }

func (a *app) widgetCertificates() widgetReply {
	now := time.Now()
	certs := a.certExpiry()
	st := widgetReply{State: "ok", UpdatedAt: now.UTC().Format(time.RFC3339)}
	items := []widgetItem{}
	soon := 0
	for i, c := range certs {
		d := certDays(c.until, now)
		state := "ok"
		value := fmt.Sprintf("до %s · %d дн.", c.until.Local().Format("02.01"), d)
		switch {
		case d < 0:
			state, value = "bad", "истёк "+c.until.Local().Format("02.01")
			st.State = "bad"
			soon++
		case d < certWarnDays:
			state = "warn"
			if st.State == "ok" {
				st.State = "warn"
			}
			soon++
		}
		if i < 6 {
			items = append(items, widgetItem{Text: c.host, State: state, Value: value, Page: "certs"})
		}
	}
	switch {
	case len(certs) == 0:
		st.State, st.Note = "unknown", "сертификатов не найдено"
	case soon > 0:
		st.Note = fmt.Sprintf("истекают в ближайшие %d дн.: %d", certWarnDays, soon)
	default:
		st.Note = fmt.Sprintf("все %d действуют дольше %d дн.", len(certs), certWarnDays)
	}
	body := map[string]any{"items": items}
	if len(certs) > len(items) {
		body["more"] = len(certs) - len(items)
	}
	st.Body = body
	return st
}

func (a *app) widgetRequests() widgetReply {
	a.telemetryMu.Lock()
	started := a.telemetry != nil
	a.telemetryMu.Unlock()
	if !started {
		return widgetReply{State: "unknown", Note: "статистика nginx не собирается", Body: map[string]any{"points": []any{}}}
	}
	now := time.Now()
	agg := a.ensureTelemetry().aggregate(now, 24*time.Hour, "", "")
	series, _ := agg["series"].([]metricBucket)
	points := make([][2]any, 0, len(series))
	for _, b := range series {
		points = append(points, [2]any{b.Time, b.Requests})
	}
	total, _ := agg["total_requests"].(int)
	rate, _ := agg["error_rate"].(float64)
	c5, _ := agg["errors_5xx"].(int)
	st := widgetReply{State: "ok", UpdatedAt: now.UTC().Format(time.RFC3339), Note: fmt.Sprintf("%d запросов · ошибок %.1f%%", total, rate)}
	if total > 50 && float64(c5)/float64(total) > 0.05 {
		st.State = "warn"
	}
	st.Body = map[string]any{"unit": "запросов", "points": points}
	return st
}

func (a *app) proxyAttention() []attentionItem {
	out := []attentionItem{}
	if !a.nginxRunning() {
		out = append(out, attentionItem{ID: "nginx-down", Severity: "critical", Text: "nginx остановлен — домены не открываются", Action: map[string]string{"label": "Открыть", "page": "proxy-system"}})
	}
	now := time.Now()
	for _, c := range a.certExpiry() {
		d := certDays(c.until, now)
		if d >= certWarnDays {
			break
		}
		it := attentionItem{ID: "cert-" + c.host, Severity: "warning", Text: fmt.Sprintf("Сертификат %s истекает через %d дн.", c.host, d), Action: map[string]string{"label": "Сертификаты", "page": "certs"}}
		if d < 0 {
			it.Severity, it.Text = "critical", "Сертификат "+c.host+" истёк "+c.until.Local().Format("02.01")
		}
		out = append(out, it)
	}
	if w := a.widgetRequests(); w.State == "warn" {
		out = append(out, attentionItem{ID: "nginx-5xx", Severity: "warning", Text: "Много ошибок 5xx за сутки: " + w.Note, Action: map[string]string{"label": "Статистика", "page": "stats"}})
	}
	return out
}

/* ---------- Network ---------- */

// netState: the latest sample, the checks it passes, and the samples of a day.
func netSnapshot() (*netSample, []netSample, []netCheck) {
	netmon.mu.Lock()
	defer netmon.mu.Unlock()
	list := append([]netSample(nil), netmon.history...)
	checks := netmon.checks()
	if len(list) == 0 {
		return nil, list, checks
	}
	return &list[len(list)-1], list, checks
}

func checkByID(checks []netCheck, id string) *netCheck {
	for i := range checks {
		if checks[i].ID == id {
			return &checks[i]
		}
	}
	return nil
}

// internetOK: either router reaches the internet by IP.
func internetOK(s netSample, checks []netCheck) (ok, valid bool) {
	for _, id := range []string{"mt-internet", "nc-internet"} {
		if c := checkByID(checks, id); c != nil {
			o, v := c.test(s)
			if v {
				valid = true
				if o {
					return true, true
				}
			}
		}
	}
	return false, valid
}

func (a *app) widgetInternet() widgetReply {
	last, _, checks := netSnapshot()
	if last == nil || time.Since(time.Unix(last.T, 0)) > 10*time.Minute {
		return widgetReply{State: "unknown", Note: "мониторинг связи ещё не собрал данные", Body: map[string]any{"label": "Нет данных", "items": []widgetItem{}}}
	}
	items := []widgetItem{}
	for _, c := range []struct{ id, name string }{{"nc-internet", "Netcraze"}, {"mt-internet", "MikroTik"}, {"lte", "LTE"}, {"proxy", "Через mihomo"}} {
		if ch := checkByID(checks, c.id); ch != nil {
			if ok, valid := ch.test(*last); valid {
				items = append(items, widgetItem{Text: c.name, OK: boolp(ok)})
			}
		}
	}
	st := widgetReply{State: "ok", UpdatedAt: stamp(last.T)}
	label := "Есть интернет"
	switch ok, _ := internetOK(*last, checks); {
	case !ok:
		st.State, label = "bad", "Нет интернета"
	default:
		for _, it := range items {
			if it.OK != nil && !*it.OK {
				st.State, label = "warn", "Частично"
				break
			}
		}
	}
	if last.API && last.RSRP != 0 {
		st.Note = fmt.Sprintf("LTE: RSRP %d дБм · SINR %d дБ", last.RSRP, last.SINR)
	}
	st.Body = map[string]any{"label": label, "items": items}
	return st
}

func (a *app) widgetAvailability() widgetReply {
	_, list, checks := netSnapshot()
	now := time.Now()
	start := now.Truncate(time.Hour).Add(-23 * time.Hour)
	okN, validN := make([]int, 24), make([]int, 24)
	for _, s := range list {
		i := int(time.Unix(s.T, 0).Sub(start) / time.Hour)
		if i < 0 || i >= 24 {
			continue
		}
		if ok, valid := internetOK(s, checks); valid {
			validN[i]++
			if ok {
				okN[i]++
			}
		}
	}
	bars := []map[string]any{}
	good, total, worst := 0, 0, 100
	for i := 0; i < 24; i++ {
		// an hour without samples is no data, not an outage
		if validN[i] == 0 {
			continue
		}
		v := okN[i] * 100 / validN[i]
		good += okN[i]
		total += validN[i]
		worst = min(worst, v)
		bars = append(bars, map[string]any{"label": start.Add(time.Duration(i) * time.Hour).Local().Format("15:00"), "value": v})
	}
	if total == 0 {
		return widgetReply{State: "unknown", Note: "мониторинг связи ещё не собрал данные", Body: map[string]any{"unit": "%", "bars": bars, "scale": "linear"}}
	}
	share := float64(good) * 100 / float64(total)
	st := widgetReply{State: "ok", UpdatedAt: stamp(list[len(list)-1].T), Note: fmt.Sprintf("интернет был %.1f%% суток · худший час %d%%", share, worst)}
	if share < 99 {
		st.State = "warn"
	}
	if share < 90 {
		st.State = "bad"
	}
	st.Body = map[string]any{"unit": "%", "bars": bars, "scale": "linear"}
	return st
}

func (a *app) networkAttention() []attentionItem {
	last, list, checks := netSnapshot()
	out := []attentionItem{}
	if last == nil || time.Since(time.Unix(last.T, 0)) > 10*time.Minute {
		return out
	}
	if ok, valid := internetOK(*last, checks); valid && !ok {
		since := last.T
		for i := len(list) - 1; i >= 0; i-- {
			if o, v := internetOK(list[i], checks); v && o {
				break
			}
			since = list[i].T
		}
		out = append(out, attentionItem{ID: "internet-down", Severity: "critical", Text: "Нет интернета ни через Netcraze, ни через MikroTik", Since: stamp(since), Action: map[string]string{"label": "Открыть", "page": "network"}})
	}
	if c := checkByID(checks, "lte"); c != nil {
		if ok, valid := c.test(*last); valid && !ok {
			out = append(out, attentionItem{ID: "lte-down", Severity: "warning", Text: "LTE на MikroTik не работает: " + last.LTE, Action: map[string]string{"label": "Открыть", "page": "antenna"}})
		}
	}
	return out
}

// handleModuleWidget serves Proxy's /api/nginx/{widgets,summary}/… and
// Network's /api/network/{widgets,summary}/…
func (a *app) handleModuleWidget(w http.ResponseWriter, r *http.Request) bool {
	widgets := map[string]func() widgetReply{
		"/api/nginx/widgets/domains":            a.widgetDomains,
		"/api/nginx/widgets/certificates":       a.widgetCertificates,
		"/api/nginx/widgets/requests-day":       a.widgetRequests,
		"/api/network/widgets/internet":         a.widgetInternet,
		"/api/network/widgets/availability-day": a.widgetAvailability,
	}
	if f, ok := widgets[r.URL.Path]; ok {
		a.writeJSON(w, http.StatusOK, f())
		return true
	}
	switch r.URL.Path {
	case "/api/nginx/summary/attention":
		a.writeJSON(w, http.StatusOK, map[string]any{"items": a.proxyAttention()})
		return true
	case "/api/network/summary/attention":
		a.writeJSON(w, http.StatusOK, map[string]any{"items": a.networkAttention()})
		return true
	}
	return false
}
