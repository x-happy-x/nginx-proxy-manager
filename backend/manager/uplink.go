package main

import (
	"time"
)

// The uplink's mode (normal, whitelist, offline) belongs to the provider's
// channel, not to a subscription: every adaptive provider of the core probes
// the same DIRECT. The fork's core keeps one answer at GET /network; an older
// core is read through its largest adaptive provider. HomeNet keeps one
// history of it, so a removed or renamed subscription no longer takes the mode
// with it («Канал провайдера: не определён»).

type channelState struct {
	Mode  string `json:"mode"`
	Since string `json:"since,omitempty"`
	From  string `json:"from,omitempty"`
	// why the mode is unknown: the core did not answer, no adaptive checks…
	Error string `json:"error,omitempty"`
}

// channelNow asks the core. providers, when the caller has them, saves a
// second request on an older core.
func channelNow(providers map[string]providerSnapshot) channelState {
	var nw struct {
		Mode  string `json:"mode"`
		Since string `json:"since"`
		From  string `json:"from"`
	}
	err := mihomoGet("/network", &nw)
	if err == nil && nw.Mode != "" {
		st := channelState{Mode: nw.Mode, Since: nw.Since, From: nw.From}
		if nw.Mode == "unknown" {
			st.Error = "ядро ещё не подтвердило режим: нет свежих adaptive-проверок"
		}
		return st
	}
	if providers == nil {
		var body struct {
			Providers map[string]providerSnapshot `json:"providers"`
		}
		if perr := mihomoGet("/providers/proxies", &body); perr != nil {
			return channelState{Mode: "unknown", Error: "нет связи с ядром mihomo: " + perr.Error()}
		}
		providers = body.Providers
	}
	best, st := -1, channelState{Mode: "unknown", Error: "в ядре нет подписки с adaptive-проверкой"}
	for name, p := range providers {
		if p.Adaptive != nil && p.Adaptive.DependsOn == "" && len(p.Proxies) > best {
			best, st = len(p.Proxies), channelState{Mode: p.Adaptive.Mode, From: name}
		}
	}
	if st.Mode == "" {
		st.Mode = "unknown"
	}
	return st
}

func addMode(list []healthPoint, start int64, mode string, keep int) []healthPoint {
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
	switch mode {
	case "normal":
		cur.Normal++
	case "whitelist":
		cur.Whitelist++
	case "offline":
		cur.Offline++
	default:
		cur.Unknown++
	}
	return list
}

// observeUplink records the channel's mode once a minute.
func (t *trafficCollector) observeUplink(now time.Time, mode string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Uplink == nil {
		t.st.Uplink = &providerHealth{}
	}
	h := t.st.Uplink
	minute := now.Truncate(time.Minute).Unix()
	// one sample per minute, in order: a repeat or a late one changes nothing
	if n := len(h.Minutes); n > 0 && h.Minutes[n-1].T >= minute {
		return
	}
	h.Minutes = addMode(h.Minutes, minute, mode, minuteKeep)
	h.Hours = addMode(h.Hours, now.Truncate(time.Hour).Unix(), mode, hourKeep)
	t.dirty = true
}

// overlayUplink: the series' minutes in each mode come from the channel's own
// history where it has the bucket. Called with t.mu held.
func (t *trafficCollector) overlayUplink(series []healthPoint, hours bool) bool {
	if t.st.Uplink == nil {
		return false
	}
	src := t.st.Uplink.Minutes
	if hours {
		src = t.st.Uplink.Hours
	}
	if len(src) == 0 {
		return false
	}
	byT := make(map[int64]healthPoint, len(src))
	for _, p := range src {
		byT[p.T] = p
	}
	for i := range series {
		if u, ok := byT[series[i].T]; ok {
			series[i].Normal, series[i].Whitelist, series[i].Offline, series[i].Unknown = u.Normal, u.Whitelist, u.Offline, u.Unknown
		}
	}
	return true
}
