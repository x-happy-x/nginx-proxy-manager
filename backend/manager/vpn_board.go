package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

/*
 * Data of the redesigned VPN screens (NPM-70): «Главная» in both modes and
 * «Серверы». One local request to the core (its subscriptions with the adaptive
 * report) plus the history HomeNet already keeps — the channel's minutes,
 * bypass traffic by day, the services' last checks. Nothing is probed here.
 */

type boardRecord struct {
	AvgMS  float64 `json:"avgMs"`
	LastMS int64   `json:"lastMs"`
	Checks uint64  `json:"checks"`
}

type boardSummary struct {
	Name        string      `json:"name"`
	Record      boardRecord `json:"record"`
	SuccessRate float64     `json:"successRate"`
	Stable      bool        `json:"stable"`
}

type boardProbe struct {
	URL  string `json:"url"`
	OK   bool   `json:"ok"`
	MS   int64  `json:"ms"`
	Fail string `json:"fail"`
}

type boardResult struct {
	Mode      string       `json:"mode"`
	OK        bool         `json:"ok"`
	Available *bool        `json:"available"`
	Skipped   string       `json:"skipped"`
	Probes    []boardProbe `json:"probes"`
	Country   string       `json:"country"`
}

type boardAdaptive struct {
	Mode          string                    `json:"mode"`
	Observed      string                    `json:"observed"`
	Pending       int                       `json:"pending"`
	CheckedAt     string                    `json:"checkedAt"`
	DependsOn     string                    `json:"dependsOn"`
	DirectAllowed []boardProbe              `json:"directAllowed"`
	DirectGlobal  []boardProbe              `json:"directGlobal"`
	Rankings      map[string][]boardSummary `json:"rankings"`
	Results       map[string]boardResult    `json:"results"`
}

type boardProvider struct {
	Proxies   []struct{ Name string } `json:"proxies"`
	Adaptive  *boardAdaptive          `json:"adaptive"`
	UpdatedAt string                  `json:"updatedAt"`
}

type boardServer struct {
	Name     string   `json:"name"`
	Rate     float64  `json:"rate"`
	MS       int      `json:"ms"`
	Checks   uint64   `json:"checks"`
	Stable   bool     `json:"stable"`
	Now      string   `json:"now"` // ok | silent | tls | reset | http | body | fail | skipped | unknown
	Country  string   `json:"country,omitempty"`
	Selected []string `json:"selected,omitempty"` // groups using it now
}

type boardDay struct {
	Day       string  `json:"day"` // local date
	Normal    int     `json:"normal"`
	Whitelist int     `json:"whitelist"`
	Offline   int     `json:"offline"`
	Unknown   int     `json:"unknown"`
	Bypass    int64   `json:"bypass"`
	Working   float64 `json:"working"`
}

type boardHour struct {
	T         int64 `json:"t"`
	Working   int   `json:"working"`
	Whitelist int   `json:"whitelist"`
}

// failOf: how a node failed, from its probes; "ok" when it answers.
func failOf(r boardResult) string {
	if r.Skipped != "" {
		return "skipped"
	}
	ok := r.OK
	if r.Available != nil {
		ok = *r.Available
	}
	if ok {
		return "ok"
	}
	for _, p := range r.Probes {
		if !p.OK && p.Fail != "" {
			return p.Fail
		}
	}
	return "fail"
}

func probeHost(raw string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(raw, "https://"), "http://")
	if i := strings.IndexAny(s, "/?"); i >= 0 {
		s = s[:i]
	}
	return s
}

var latencyEdges = []int{300, 500, 700, 1000, 1500}

func latencyBin(ms int) int {
	for i, e := range latencyEdges {
		if ms < e {
			return i
		}
	}
	return len(latencyEdges)
}

func (a *app) vpnBoard(days int) response {
	now := time.Now()
	out := response{"ok": true, "generated_at": now.UTC().Format(time.RFC3339)}

	var body struct {
		Providers map[string]boardProvider `json:"providers"`
	}
	coreErr := mihomoGet("/providers/proxies", &body)
	main, best := "", -1
	for name, p := range body.Providers {
		if p.Adaptive != nil && p.Adaptive.DependsOn == "" && len(p.Proxies) > best {
			main, best = name, len(p.Proxies)
		}
	}
	// groups: which node each one uses now
	selected := map[string][]string{}
	var groups struct {
		Proxies map[string]proxySnapshot `json:"proxies"`
	}
	if mihomoGet("/proxies", &groups) == nil {
		for name, g := range groups.Proxies {
			if groupTypes[g.Type] && g.Now != "" && !g.Hidden && name != "GLOBAL" {
				selected[g.Now] = append(selected[g.Now], name)
			}
		}
		for k := range selected {
			sort.Strings(selected[k])
		}
	}
	if coreErr != nil {
		out["core_error"] = "нет связи с ядром mihomo: " + shortNetErr(coreErr).Error()
	}

	ch := channelNow(nil)
	channel := response{"mode": ch.Mode, "since": ch.Since, "error": ch.Error}
	if main != "" {
		p := body.Providers[main]
		ad := p.Adaptive
		direct := []response{}
		for _, list := range [][]boardProbe{ad.DirectAllowed, ad.DirectGlobal} {
			for _, pr := range list {
				direct = append(direct, response{"host": probeHost(pr.URL), "ok": pr.OK, "ms": pr.MS, "fail": pr.Fail})
			}
		}
		channel["direct"] = direct
		channel["observed"] = ad.Observed

		rows := map[string][]boardServer{}
		bins := map[string][]int{}
		lat := map[string][]int{}
		stable := map[string]int{}
		for mode, list := range ad.Rankings {
			rs := make([]boardServer, 0, len(list))
			b, l := make([]int, 10), make([]int, len(latencyEdges)+1)
			for _, s := range list {
				r := ad.Results[s.Name]
				row := boardServer{Name: s.Name, Rate: round2(s.SuccessRate), MS: int(s.Record.AvgMS), Checks: s.Record.Checks, Stable: s.Stable, Now: "unknown", Country: r.Country, Selected: selected[s.Name]}
				if _, ok := ad.Results[s.Name]; ok {
					row.Now = failOf(r)
				}
				rs = append(rs, row)
				if s.Record.Checks == 0 {
					continue
				}
				i := int(s.SuccessRate * 10)
				if i > 9 {
					i = 9
				}
				b[i]++
				if s.Record.LastMS > 0 && s.Record.AvgMS > 0 {
					l[latencyBin(int(s.Record.AvgMS))]++
				}
				if s.Stable {
					stable[mode]++
				}
			}
			sort.SliceStable(rs, func(i, j int) bool {
				if rs[i].Stable != rs[j].Stable {
					return rs[i].Stable
				}
				return rs[i].Rate > rs[j].Rate
			})
			rows[mode], bins[mode], lat[mode] = rs, b, l
		}
		answering, fails := 0, map[string]int{}
		for _, r := range ad.Results {
			f := failOf(r)
			if f == "ok" {
				answering++
			} else if f != "skipped" {
				fails[f]++
			}
		}
		out["provider"] = response{"name": main, "total": len(p.Proxies), "checked_at": ad.CheckedAt, "pending": ad.Pending, "mode": ad.Mode, "updated_at": p.UpdatedAt}
		out["servers"] = response{"answering": answering, "stable": stable, "fails": fails, "rows": rows, "bins": bins, "latency": lat, "latency_edges": latencyEdges}
	}
	out["channel"] = channel

	// a week by local day: the channel's minutes, bypass traffic, answering servers
	if traffic != nil {
		out["week"] = traffic.boardWeek(main, now, days)
		out["hours"] = traffic.boardHours(main, now)
		if logs := traffic.provLog(main); len(logs) > 0 {
			out["provider_updates"] = logs
		}
	}

	checked, list := serviceSnapshot()
	svc := []response{}
	ok := 0
	for _, s := range list {
		r, has := lastResult(s)
		item := response{"id": s.ID, "name": s.Name, "what": s.What, "group": s.Group, "path": s.Path, "checked": has}
		if has {
			item["ok"], item["ms"], item["error"] = r.OK, r.MS, r.Error
			if r.OK {
				ok++
			} else {
				item["since"] = stamp(failingSince(s))
			}
		}
		svc = append(svc, item)
	}
	out["services"] = response{"checked_at": stamp(checked), "ok": ok, "total": len(list), "items": svc}
	return out
}

// boardWeek: the last n local days (7 or 30), today last.
func (t *trafficCollector) boardWeek(provider string, now time.Time, n int) []boardDay {
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(n - 1))
	days := make([]boardDay, n)
	for i := range days {
		days[i].Day = start.AddDate(0, 0, i).Format("2006-01-02")
	}
	idx := func(unix int64) int {
		d := time.Unix(unix, 0).In(now.Location())
		day := time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, now.Location())
		i := int(day.Sub(start).Hours()/24 + 0.5)
		if i < 0 || i >= n {
			return -1
		}
		return i
	}
	c := currentClassifier()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Uplink != nil {
		for _, h := range t.st.Uplink.Hours {
			if i := idx(h.T); i >= 0 {
				days[i].Normal += h.Normal
				days[i].Whitelist += h.Whitelist
				days[i].Offline += h.Offline
				days[i].Unknown += h.Unknown
			}
		}
	}
	for _, p := range routeSeries(t.st.DimDays, start.Unix(), c) {
		if i := idx(p.T); i >= 0 {
			days[i].Bypass += p.Bypass + p.Chain
		}
	}
	if h := t.st.Health[provider]; h != nil {
		sum, cnt := make([]int, n), make([]int, n)
		alt := make([]boardDay, n)
		for _, p := range h.Hours {
			if i := idx(p.T); i >= 0 {
				sum[i] += p.Working
				cnt[i]++
				alt[i].Normal += p.Normal
				alt[i].Whitelist += p.Whitelist
				alt[i].Offline += p.Offline
				alt[i].Unknown += p.Unknown
			}
		}
		// the channel's own history began later (NPM-new, 12.10): before it, the
		// main subscription's modes stand for the channel
		for i := range days {
			if days[i].Normal+days[i].Whitelist+days[i].Offline == 0 {
				days[i].Normal, days[i].Whitelist, days[i].Offline, days[i].Unknown = alt[i].Normal, alt[i].Whitelist, alt[i].Offline, alt[i].Unknown
			}
		}
		for i := range days {
			if cnt[i] > 0 {
				days[i].Working = round2(float64(sum[i]) / float64(cnt[i]))
			}
		}
	}
	// a day has 1440 minutes: older history counted some minutes twice (two
	// collectors once wrote it), so a day over 24 hours is scaled back
	for i := range days {
		d := &days[i]
		if sum := d.Normal + d.Whitelist + d.Offline + d.Unknown; sum > 1440 {
			d.Normal, d.Whitelist, d.Offline = d.Normal*1440/sum, d.Whitelist*1440/sum, d.Offline*1440/sum
			d.Unknown = 1440 - d.Normal - d.Whitelist - d.Offline
		}
	}
	return days
}

func (t *trafficCollector) boardHours(provider string, now time.Time) []boardHour {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := []boardHour{}
	h := t.st.Health[provider]
	if h == nil {
		return out
	}
	from := now.Add(-24 * time.Hour).Unix()
	for _, p := range h.Hours {
		if p.T >= from {
			out = append(out, boardHour{T: p.T, Working: p.Working, Whitelist: p.Whitelist})
		}
	}
	return out
}

func (t *trafficCollector) provLog(provider string) []provUpdate {
	t.mu.Lock()
	defer t.mu.Unlock()
	list := t.st.ProvLog[provider]
	if len(list) > 5 {
		list = list[len(list)-5:]
	}
	return append([]provUpdate(nil), list...)
}

func (a *app) handleVPNBoard(w http.ResponseWriter, r *http.Request) {
	days := 7
	if r.URL.Query().Get("days") == "30" {
		days = 30
	}
	a.writeJSON(w, http.StatusOK, a.vpnBoard(days))
}
