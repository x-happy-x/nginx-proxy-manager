package main

import (
	"net/http"
	"sort"
	"time"
)

// History of the fork's adaptive checks (NPM-29): once a minute, for every
// provider with adaptive health, the confirmed network mode and how many of
// its nodes are admitted. The core only reports the present, so the router
// keeps the past: minutes for 24 hours, hours for 30 days.

type healthPoint struct {
	T int64 `json:"t"`
	// Minutes spent in each confirmed mode within the bucket.
	Normal    int `json:"normal"`
	Whitelist int `json:"whitelist"`
	Offline   int `json:"offline"`
	Unknown   int `json:"unknown"`
	// Admitted nodes: the last sample for a minute, the average for an hour.
	Working int `json:"working"`
	Total   int `json:"total"`
	// Stable nodes in the normal and whitelist rankings at the end of the bucket.
	StableNormal    int `json:"stable_normal"`
	StableWhitelist int `json:"stable_whitelist"`
	samples         int
	workingSum      int
}

type providerHealth struct {
	Minutes []healthPoint `json:"minutes"`
	Hours   []healthPoint `json:"hours"`
}

type adaptiveSnapshot struct {
	Mode     string `json:"mode"`
	Rankings map[string][]struct {
		Stable bool `json:"stable"`
	} `json:"rankings"`
	Results map[string]struct {
		OK        bool   `json:"ok"`
		Available *bool  `json:"available"`
		Skipped   string `json:"skipped"`
	} `json:"results"`
	DependsOn string `json:"dependsOn"`
}

type providerSnapshot struct {
	Proxies []struct {
		Name  string `json:"name"`
		Alive bool   `json:"alive"`
	} `json:"proxies"`
	Adaptive *adaptiveSnapshot `json:"adaptive"`
}

// working counts nodes the fork admits now: `available` when the core reports
// thresholds (MIHOMO-5+), otherwise the last probe; skipped nodes do not count.
func working(a *adaptiveSnapshot) int {
	n := 0
	for _, r := range a.Results {
		if r.Skipped != "" {
			continue
		}
		if r.Available != nil {
			if *r.Available {
				n++
			}
		} else if r.OK {
			n++
		}
	}
	return n
}

func stableCount(a *adaptiveSnapshot, mode string) int {
	n := 0
	for _, r := range a.Rankings[mode] {
		if r.Stable {
			n++
		}
	}
	return n
}

func addHealth(list []healthPoint, start int64, p providerSnapshot, keep int) []healthPoint {
	a := p.Adaptive
	var cur *healthPoint
	if n := len(list); n > 0 && list[n-1].T == start {
		cur = &list[n-1]
	} else {
		list = append(list, healthPoint{T: start})
		if len(list) > keep {
			list = list[len(list)-keep:]
		}
		cur = &list[len(list)-1]
	}
	switch a.Mode {
	case "normal":
		cur.Normal++
	case "whitelist":
		cur.Whitelist++
	case "offline":
		cur.Offline++
	default:
		cur.Unknown++
	}
	w := working(a)
	cur.samples++
	cur.workingSum += w
	cur.Working = (cur.workingSum + cur.samples/2) / cur.samples
	cur.Total = len(p.Proxies)
	cur.StableNormal = stableCount(a, "normal")
	cur.StableWhitelist = stableCount(a, "whitelist")
	return list
}

func (t *trafficCollector) observeHealth(now time.Time, providers map[string]providerSnapshot) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Health == nil {
		t.st.Health = map[string]*providerHealth{}
	}
	minute := now.Truncate(time.Minute).Unix()
	hour := now.Truncate(time.Hour).Unix()
	for name, p := range providers {
		if p.Adaptive == nil {
			continue
		}
		h := t.st.Health[name]
		if h == nil {
			h = &providerHealth{}
			t.st.Health[name] = h
		}
		// One sample per minute: a repeat within the same minute replaces nothing.
		if n := len(h.Minutes); n > 0 && h.Minutes[n-1].T == minute {
			continue
		}
		h.Minutes = addHealth(h.Minutes, minute, p, minuteKeep)
		h.Hours = addHealth(h.Hours, hour, p, hourKeep)
	}
	t.dirty = true
}

func (t *trafficCollector) healthReport(provider, period string, now time.Time) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	span := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[period]
	if span == 0 {
		period, span = "24h", 24*time.Hour
	}
	names := []string{}
	for name := range t.st.Health {
		names = append(names, name)
	}
	sort.Strings(names)
	h := t.st.Health[provider]
	if h == nil && len(names) > 0 {
		// No provider asked: the main subscription, the one with most nodes.
		best := -1
		for _, name := range names {
			c := t.st.Health[name]
			if n := len(c.Minutes); n > 0 && c.Minutes[n-1].Total > best {
				best, provider = c.Minutes[n-1].Total, name
			}
		}
		if best < 0 {
			provider = names[0]
		}
		h = t.st.Health[provider]
	}
	series := []healthPoint{}
	resolution := 60
	if h != nil {
		src := h.Minutes
		if span > 24*time.Hour {
			src, resolution = h.Hours, 3600
		}
		from := now.Add(-span).Unix()
		for _, p := range src {
			if p.T >= from-int64(resolution) {
				series = append(series, p)
			}
		}
	}
	return map[string]any{"provider": provider, "providers": names, "period": period, "resolution": resolution, "series": series}
}

func (a *app) handleCoreHealth(w http.ResponseWriter, r *http.Request) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт на роутере не запущен"})
		return
	}
	rep := traffic.healthReport(r.URL.Query().Get("provider"), r.URL.Query().Get("period"), time.Now())
	rep["ok"] = true
	a.writeJSON(w, http.StatusOK, rep)
}
