package main

import "time"

// Daily provider/mode aggregates, kept with traffic.json.gz for 30 days.
// Connection attribution is sampled, and deliberately excludes pre-start bytes.
type slUsage struct {
	Up            int64 `json:"up"`
	Down          int64 `json:"down"`
	Connections   int   `json:"connections"`
	ActiveSeconds int64 `json:"active_seconds"`
	Observed      int   `json:"observed"`
	Working       int   `json:"working"`
	Exclusive     int   `json:"exclusive"`
}
type slUsageDay struct {
	T         int64                          `json:"t"`
	Providers map[string]map[string]*slUsage `json:"providers"`
}

func (t *trafficCollector) slStat(now time.Time, provider, mode string) *slUsage {
	day := now.UTC().Truncate(24 * time.Hour).Unix()
	if len(t.st.Subscriptions) == 0 || t.st.Subscriptions[len(t.st.Subscriptions)-1].T != day {
		days := t.st.Subscriptions[:0]
		for _, d := range t.st.Subscriptions {
			if d.T >= day-29*86400 {
				days = append(days, d)
			}
		}
		t.st.Subscriptions = append(days, slUsageDay{T: day, Providers: map[string]map[string]*slUsage{}})
	}
	d := &t.st.Subscriptions[len(t.st.Subscriptions)-1]
	if d.Providers[provider] == nil {
		d.Providers[provider] = map[string]*slUsage{}
	}
	if d.Providers[provider][mode] == nil {
		d.Providers[provider][mode] = &slUsage{}
	}
	return d.Providers[provider][mode]
}
func (t *trafficCollector) slMode(now time.Time) string {
	if h := t.st.Uplink; h != nil && len(h.Minutes) > 0 {
		m := h.Minutes[len(h.Minutes)-1]
		if now.Unix()-m.T <= 120 {
			if m.Normal > 0 {
				return "normal"
			}
			if m.Whitelist > 0 {
				return "whitelist"
			}
			if m.Offline > 0 {
				return "offline"
			}
		}
	}
	return "unknown"
}
func (t *trafficCollector) slConnections(now time.Time, conns []mihomoConn, baseline bool) {
	mode := t.slMode(now)
	active := map[string]bool{}
	seconds := int64(0)
	if !t.slLastPoll.IsZero() {
		seconds = int64(now.Sub(t.slLastPoll).Seconds())
		if seconds < 0 || seconds > 15 {
			seconds = 0
		}
	}
	t.slLastPoll = now
	for _, c := range conns {
		if baseline {
			continue
		}
		prev, known := t.live[c.ID]
		up, down := c.Upload, c.Download
		if known {
			up -= prev.up
			down -= prev.down
			if up < 0 || down < 0 {
				up, down = c.Upload, c.Download
			}
		}
		seen := map[string]bool{}
		for _, provider := range c.ProviderChains {
			if provider == "" || provider == "default" || provider == "COMPATIBLE" || seen[provider] {
				continue
			}
			seen[provider] = true
			st := t.slStat(now, provider, mode)
			st.Up += up
			st.Down += down
			if !known {
				st.Connections++
			}
			if up+down > 0 {
				active[provider] = true
			}
		}
	}
	for provider := range active {
		t.slStat(now, provider, mode).ActiveSeconds += seconds
	}
}
func (t *trafficCollector) slHealth(now time.Time, providers map[string]providerSnapshot) {
	minute := now.UTC().Truncate(time.Minute).Unix()
	if t.slLastHealth >= minute {
		return
	}
	t.slLastHealth = minute
	mode := t.slMode(now)
	eligible := map[string]bool{}
	available := map[string]bool{}
	count := 0
	for name, p := range providers {
		if p.Adaptive == nil || p.Adaptive.DependsOn != "" || (p.VehicleType != "HTTP" && p.VehicleType != "File") {
			continue
		}
		// A cached result in a different network mode is not an observation.
		if p.Adaptive.Mode != mode {
			continue
		}
		for _, r := range p.Adaptive.Results {
			if r.Skipped != "" || r.At.IsZero() || now.Sub(r.At) > 3*time.Minute || r.At.After(now.Add(time.Minute)) {
				continue
			}
			eligible[name] = true
			ok := r.OK
			if r.Available != nil {
				ok = *r.Available
			}
			if ok {
				available[name] = true
			}
		}
		if available[name] {
			count++
		}
	}
	for name := range eligible {
		st := t.slStat(now, name, mode)
		st.Observed++
		if available[name] {
			st.Working++
			if count == 1 {
				st.Exclusive++
			}
		}
	}
}

type slUsageRow struct {
	Provider string              `json:"provider"`
	Modes    map[string]*slUsage `json:"modes"`
	Advice   string              `json:"advice"`
	Reason   string              `json:"reason"`
}

func slUsageReport(t *trafficCollector, now time.Time) []slUsageRow {
	rows := []slUsageRow{}
	if t == nil {
		return rows
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	all := map[string]map[string]*slUsage{}
	for _, day := range t.st.Subscriptions {
		if day.T < now.UTC().Truncate(24*time.Hour).Unix()-29*86400 {
			continue
		}
		for name, modes := range day.Providers {
			if all[name] == nil {
				all[name] = map[string]*slUsage{}
			}
			for mode, s := range modes {
				if all[name][mode] == nil {
					all[name][mode] = &slUsage{}
				}
				a := all[name][mode]
				a.Up += s.Up
				a.Down += s.Down
				a.Connections += s.Connections
				a.ActiveSeconds += s.ActiveSeconds
				a.Observed += s.Observed
				a.Working += s.Working
				a.Exclusive += s.Exclusive
			}
		}
	}
	for _, name := range slSortedKeys(all) {
		modes := all[name]
		observed, used, exclusive, wl := 0, int64(0), 0, 0
		for mode, s := range modes {
			observed += s.Observed
			used += s.Up + s.Down
			exclusive += s.Exclusive
			if mode == "whitelist" {
				wl = s.Observed
			}
		}
		row := slUsageRow{Provider: name, Modes: modes, Advice: "wait", Reason: "Мало данных: нужно 7 суток наблюдений и хотя бы 30 минут белых списков. Отсутствие трафика ещё не повод отказываться от резерва."}
		if observed >= 7*24*60 && wl >= 30 {
			if exclusive >= 30 {
				row.Advice = "keep"
				row.Reason = "Была единственным проверенным рабочим источником не менее 30 минут; полезна как резерв."
			} else if used >= 10*1024*1024 {
				row.Advice = "keep"
				row.Reason = "Используется: замечено не менее 10 МиБ трафика за период."
			} else {
				row.Advice = "review"
				row.Reason = "Мало замеченного трафика, длительной уникальной доступности не было. Перед отказом проверьте резерв и тариф."
			}
		}
		rows = append(rows, row)
	}
	return rows
}
