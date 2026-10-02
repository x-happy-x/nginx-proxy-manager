package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

/*
 * Traffic through bypass nodes (NPM-36). Bypass nodes have a traffic limit,
 * so the console shows how much went through them, through the cascade
 * (which also spends bypass traffic), through other servers and directly.
 * The class comes from the node that carried the connection and the bypass
 * words of «Маршрутизация»; it is computed when the report is built, so the
 * history recorded before NPM-36 is classified too.
 */

const (
	routeDirect = "direct"
	routeProxy  = "proxy"
	routeBypass = "bypass"
	routeChain  = "chain"
)

type routeClassifier struct{ bypass *regexp.Regexp }

var (
	classifierMu    sync.Mutex
	classifierCache routeClassifier
	classifierMod   time.Time
	classifierOK    bool
)

// currentClassifier follows routing.json; it is cheap to call on every poll.
func currentClassifier() routeClassifier {
	classifierMu.Lock()
	defer classifierMu.Unlock()
	var mod time.Time
	if fi, err := os.Stat(routingPath()); err == nil {
		mod = fi.ModTime()
	}
	if classifierOK && mod.Equal(classifierMod) {
		return classifierCache
	}
	s, _ := loadRouting()
	c := routeClassifier{}
	if len(s.Bypass) > 0 {
		c.bypass, _ = regexp.Compile(wordsRE(s.Bypass))
	}
	classifierCache, classifierMod, classifierOK = c, mod, true
	return c
}

func (c routeClassifier) class(outbound string) string {
	switch {
	case outbound == "":
		return ""
	case outbound == "DIRECT":
		return routeDirect
	case strings.HasPrefix(outbound, "REJECT"):
		return ""
	case strings.HasPrefix(outbound, "⛓ "):
		return routeChain
	case c.bypass != nil && c.bypass.MatchString(outbound):
		return routeBypass
	default:
		return routeProxy
	}
}

type routePoint struct {
	T      int64 `json:"t"`
	Direct int64 `json:"direct"`
	Proxy  int64 `json:"proxy"`
	Bypass int64 `json:"bypass"`
	Chain  int64 `json:"chain"`
}

func (p *routePoint) add(class string, bytes int64) {
	switch class {
	case routeDirect:
		p.Direct += bytes
	case routeProxy:
		p.Proxy += bytes
	case routeBypass:
		p.Bypass += bytes
	case routeChain:
		p.Chain += bytes
	}
}

// routeSeries sums each bucket's outbound dimension by class.
func routeSeries(buckets []dimBucket, from int64, c routeClassifier) []routePoint {
	out := []routePoint{}
	for _, b := range buckets {
		if b.T < from {
			continue
		}
		p := routePoint{T: b.T}
		for node, s := range b.Dims["outbound"] {
			p.add(c.class(node), s.Up+s.Down)
		}
		out = append(out, p)
	}
	return out
}

/* ---------- monthly limit ---------- */

type bypassLimit struct {
	GB  int `json:"gb"`  // 0: no limit
	Day int `json:"day"` // day of month the limit restarts, 1..28
}

func bypassLimitPath() string { return filepath.Join(coreStateDir(), "bypass-limit.json") }

func loadBypassLimit() bypassLimit {
	l := bypassLimit{Day: 1}
	if body, err := os.ReadFile(bypassLimitPath()); err == nil {
		_ = json.Unmarshal(body, &l)
	}
	if l.Day < 1 || l.Day > 28 {
		l.Day = 1
	}
	return l
}

// cycleStart is the last time the limit restarted (midnight of l.Day).
func cycleStart(l bypassLimit, now time.Time) time.Time {
	y, m, d := now.Date()
	start := time.Date(y, m, l.Day, 0, 0, 0, 0, now.Location())
	if d < l.Day {
		start = start.AddDate(0, -1, 0)
	}
	return start
}

func (a *app) handleBypassLimit(w http.ResponseWriter, r *http.Request) {
	var l bypassLimit
	if !a.decodeJSON(w, r, &l) {
		return
	}
	if l.GB < 0 || l.GB > 100000 || l.Day < 1 || l.Day > 28 {
		a.writeJSON(w, http.StatusUnprocessableEntity, response{"ok": false, "error": errors.New("лимит: 0–100000 ГБ, день сброса 1–28").Error()})
		return
	}
	if err := os.MkdirAll(coreStateDir(), 0o755); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	body, _ := json.Marshal(l)
	if err := os.WriteFile(bypassLimitPath(), body, 0o644); err != nil {
		a.writeJSON(w, http.StatusInternalServerError, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, http.StatusOK, response{"ok": true, "limit": l})
}

// bypassReport adds the class series, the totals and the monthly usage.
func (t *trafficCollector) bypassReport(period string, now time.Time) map[string]any {
	c := currentClassifier()
	t.mu.Lock()
	defer t.mu.Unlock()
	var from int64
	var buckets []dimBucket
	switch period {
	case "30d":
		from, buckets = now.AddDate(0, 0, -30).Unix(), t.st.DimDays
	case "7d":
		from, buckets = now.AddDate(0, 0, -7).Unix(), t.st.DimDays
	default:
		period = "24h"
		from, buckets = now.Add(-24*time.Hour).Truncate(time.Hour).Unix(), t.st.DimHours
	}
	series := routeSeries(buckets, from, c)
	total := routePoint{}
	for _, p := range series {
		total.Direct += p.Direct
		total.Proxy += p.Proxy
		total.Bypass += p.Bypass
		total.Chain += p.Chain
	}
	l := loadBypassLimit()
	start := cycleStart(l, now)
	used := int64(0)
	for _, p := range routeSeries(t.st.DimDays, start.Unix(), c) {
		used += p.Bypass + p.Chain
	}
	next := start.AddDate(0, 1, 0)
	return map[string]any{
		"period": period, "series": series, "total": total, "since": t.st.Since,
		"limit": map[string]any{"gb": l.GB, "day": l.Day, "used": used, "cycle_start": start.Unix(), "cycle_end": next.Unix()},
	}
}

func (a *app) handleBypassTraffic(w http.ResponseWriter, r *http.Request) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт трафика не запущен"})
		return
	}
	rep := traffic.bypassReport(r.URL.Query().Get("period"), time.Now())
	rep["ok"] = true
	a.writeJSON(w, http.StatusOK, rep)
}
