package main

import (
	"compress/gzip"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Mihomo traffic is recorded on the router all the time, not only while a
// browser has the console open (NPM-28). Every few seconds the collector reads
// /connections from the local controller:
//   - totals come from downloadTotal/uploadTotal, so they are exact; a core
//     restart (counters going down) starts a new baseline instead of a negative;
//   - the per-device/outbound/group/site split comes from each connection's
//     growth since the previous poll (a connection opened and closed between
//     two polls is not attributed).
// Retention: minutes for 24 hours, hours for 30 days; the split by hour for
// 24 hours and by day for 30 days; the last closedKeep closed connections.

const (
	trafficPoll      = 5 * time.Second
	minuteKeep       = 24 * 60
	hourKeep         = 30 * 24
	dimHourKeep      = 24
	dimDayKeep       = 30
	dimKeysPerBucket = 300
	closedKeep       = 2000
)

type trafficPoint struct {
	T     int64 `json:"t"` // unix seconds at the start of the bucket
	Up    int64 `json:"up"`
	Down  int64 `json:"down"`
	Conns int   `json:"conns"` // peak open connections in the bucket
}

type dimStat struct {
	Up    int64 `json:"up"`
	Down  int64 `json:"down"`
	Count int   `json:"count"` // connections seen opening in the bucket
}

type dimBucket struct {
	T    int64                          `json:"t"`
	Dims map[string]map[string]*dimStat `json:"dims"` // dimension -> key -> stat
}

type closedConn struct {
	Host    string   `json:"host"`
	Source  string   `json:"source"`
	Process string   `json:"process,omitempty"`
	Rule    string   `json:"rule"`
	Chains  []string `json:"chains"`
	Up      int64    `json:"up"`
	Down    int64    `json:"down"`
	Start   string   `json:"start"`
	End     int64    `json:"end"`
	Network string   `json:"network"`
}

type trafficState struct {
	Since    int64          `json:"since"`
	Minutes  []trafficPoint `json:"minutes"`
	Hours    []trafficPoint `json:"hours"`
	DimHours []dimBucket    `json:"dim_hours"`
	DimDays  []dimBucket    `json:"dim_days"`
	Closed   []closedConn   `json:"closed"`
	// Adaptive health per provider (NPM-29).
	Health map[string]*providerHealth `json:"health,omitempty"`
}

type liveConn struct {
	up, down int64
	c        mihomoConn
}

type mihomoConn struct {
	ID          string   `json:"id"`
	Upload      int64    `json:"upload"`
	Download    int64    `json:"download"`
	Start       string   `json:"start"`
	Chains      []string `json:"chains"`
	Rule        string   `json:"rule"`
	RulePayload string   `json:"rulePayload"`
	Metadata    struct {
		Network       string `json:"network"`
		SourceIP      string `json:"sourceIP"`
		Host          string `json:"host"`
		SniffHost     string `json:"sniffHost"`
		DestinationIP string `json:"destinationIP"`
		Process       string `json:"process"`
	} `json:"metadata"`
}

type trafficCollector struct {
	mu        sync.Mutex
	path      string
	st        trafficState
	live      map[string]liveConn
	lastUp    int64
	lastDown  int64
	haveTotal bool
	started   bool
	dirty     bool
}

var traffic *trafficCollector

func trafficStatePath() string {
	return filepath.Join(coreStateDir(), "traffic.json.gz")
}

func newTrafficCollector(path string, now time.Time) *trafficCollector {
	t := &trafficCollector{path: path, live: map[string]liveConn{}}
	t.st.Since = now.Unix()
	t.load()
	return t
}

func (a *app) startMihomoTraffic() {
	// The staged test manager of a deploy must not write the live state file.
	if os.Getenv("MAINTENANCE_DISABLED") == "1" || os.Getenv("MIHOMO_TRAFFIC_DISABLED") == "1" {
		return
	}
	traffic = newTrafficCollector(trafficStatePath(), time.Now())
	go func() {
		tick := time.NewTicker(trafficPoll)
		save := time.NewTicker(time.Minute)
		defer tick.Stop()
		defer save.Stop()
		for {
			select {
			case <-tick.C:
				var body struct {
					DownloadTotal int64        `json:"downloadTotal"`
					UploadTotal   int64        `json:"uploadTotal"`
					Connections   []mihomoConn `json:"connections"`
				}
				if err := mihomoGet("/connections", &body); err == nil {
					traffic.observe(time.Now(), body.UploadTotal, body.DownloadTotal, body.Connections)
				}
			case <-save.C:
				var body struct {
					Providers map[string]providerSnapshot `json:"providers"`
				}
				if err := mihomoGet("/providers/proxies", &body); err == nil {
					traffic.observeHealth(time.Now(), body.Providers)
				}
				traffic.save()
			}
		}
	}()
}

func connHost(c mihomoConn) string {
	for _, h := range []string{c.Metadata.Host, c.Metadata.SniffHost, c.Metadata.DestinationIP} {
		if h != "" {
			return h
		}
	}
	return "—"
}

// siteOf: the registrable-ish part of a host name, as the console groups sites.
func siteOf(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" || strings.Contains(host, ":") || strings.Trim(host, "0123456789.") == "" {
		return host
	}
	parts := strings.Split(host, ".")
	if len(parts) <= 2 {
		return host
	}
	take := 2
	switch parts[len(parts)-2] {
	case "co", "com", "net", "org", "gov", "ac", "msk", "spb":
		take = 3
	}
	return strings.Join(parts[len(parts)-take:], ".")
}

func dimKeys(c mihomoConn, cls routeClassifier) map[string]string {
	keys := map[string]string{
		"device":   c.Metadata.SourceIP,
		"site":     siteOf(connHost(c)),
		"process":  c.Metadata.Process,
		"outbound": "",
		"group":    "",
	}
	if n := len(c.Chains); n > 0 {
		keys["outbound"] = c.Chains[0]
		keys["group"] = c.Chains[n-1]
		// who spends the bypass traffic: device and site together (NPM-36)
		if k := cls.class(c.Chains[0]); k == routeBypass || k == routeChain {
			keys["bypass_use"] = c.Metadata.SourceIP + "|" + siteOf(connHost(c)) + "|" + c.Chains[n-1]
		}
	}
	return keys
}

func addPoint(list []trafficPoint, start int64, up, down int64, conns int, keep int) []trafficPoint {
	if n := len(list); n > 0 && list[n-1].T == start {
		list[n-1].Up += up
		list[n-1].Down += down
		if conns > list[n-1].Conns {
			list[n-1].Conns = conns
		}
		return list
	}
	list = append(list, trafficPoint{T: start, Up: up, Down: down, Conns: conns})
	if len(list) > keep {
		list = list[len(list)-keep:]
	}
	return list
}

func bucketFor(list []dimBucket, start int64, keep int) ([]dimBucket, *dimBucket) {
	if n := len(list); n > 0 && list[n-1].T == start {
		return list, &list[n-1]
	}
	// Trim the bucket being closed to its biggest keys, so memory stays bounded.
	if n := len(list); n > 0 {
		for dim, m := range list[n-1].Dims {
			list[n-1].Dims[dim] = topKeys(m, dimKeysPerBucket)
		}
	}
	list = append(list, dimBucket{T: start, Dims: map[string]map[string]*dimStat{}})
	if len(list) > keep {
		list = list[len(list)-keep:]
	}
	return list, &list[len(list)-1]
}

func topKeys(m map[string]*dimStat, n int) map[string]*dimStat {
	if len(m) <= n {
		return m
	}
	type kv struct {
		k string
		v *dimStat
	}
	all := make([]kv, 0, len(m))
	for k, v := range m {
		all = append(all, kv{k, v})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].v.Up+all[i].v.Down > all[j].v.Up+all[j].v.Down })
	out := make(map[string]*dimStat, n)
	for _, e := range all[:n] {
		out[e.k] = e.v
	}
	return out
}

func (b *dimBucket) add(keys map[string]string, up, down int64, opened bool) {
	for dim, key := range keys {
		if key == "" {
			continue
		}
		m := b.Dims[dim]
		if m == nil {
			m = map[string]*dimStat{}
			b.Dims[dim] = m
		}
		s := m[key]
		if s == nil {
			s = &dimStat{}
			m[key] = s
		}
		s.Up += up
		s.Down += down
		if opened {
			s.Count++
		}
	}
}

func (t *trafficCollector) observe(now time.Time, upTotal, downTotal int64, conns []mihomoConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	minute := now.Truncate(time.Minute).Unix()
	hour := now.Truncate(time.Hour).Unix()
	y, m, d := now.Date()
	day := time.Date(y, m, d, 0, 0, 0, 0, now.Location()).Unix()

	var up, down int64
	if t.haveTotal {
		up, down = upTotal-t.lastUp, downTotal-t.lastDown
		if up < 0 || down < 0 {
			// The core restarted: its counters started from zero again.
			up, down = upTotal, downTotal
		}
	}
	t.lastUp, t.lastDown, t.haveTotal = upTotal, downTotal, true
	t.st.Minutes = addPoint(t.st.Minutes, minute, up, down, len(conns), minuteKeep)
	t.st.Hours = addPoint(t.st.Hours, hour, up, down, len(conns), hourKeep)

	var hb, db *dimBucket
	t.st.DimHours, hb = bucketFor(t.st.DimHours, hour, dimHourKeep)
	t.st.DimDays, db = bucketFor(t.st.DimDays, day, dimDayKeep)

	// The first poll after a start only learns the open connections: their
	// earlier bytes belong to time this process did not observe.
	cls := currentClassifier()
	baseline := len(t.live) == 0 && !t.started
	t.started = true
	seen := make(map[string]liveConn, len(conns))
	for _, c := range conns {
		if baseline {
			seen[c.ID] = liveConn{up: c.Upload, down: c.Download, c: c}
			continue
		}
		prev, known := t.live[c.ID]
		du, dd := c.Upload, c.Download
		if known {
			du, dd = c.Upload-prev.up, c.Download-prev.down
			if du < 0 || dd < 0 {
				du, dd = c.Upload, c.Download
			}
		}
		keys := dimKeys(c, cls)
		if du != 0 || dd != 0 || !known {
			hb.add(keys, du, dd, !known)
			db.add(keys, du, dd, !known)
		}
		seen[c.ID] = liveConn{up: c.Upload, down: c.Download, c: c}
	}
	for id, old := range t.live {
		if _, ok := seen[id]; ok {
			continue
		}
		c := old.c
		rule := c.Rule
		if c.RulePayload != "" {
			rule += " " + c.RulePayload
		}
		t.st.Closed = append(t.st.Closed, closedConn{
			Host: connHost(c), Source: c.Metadata.SourceIP, Process: c.Metadata.Process, Rule: rule,
			Chains: c.Chains, Up: old.up, Down: old.down, Start: c.Start, End: now.Unix(), Network: c.Metadata.Network,
		})
	}
	if n := len(t.st.Closed); n > closedKeep {
		t.st.Closed = t.st.Closed[n-closedKeep:]
	}
	t.live = seen
	t.dirty = true
}

func (t *trafficCollector) load() {
	f, err := os.Open(t.path)
	if err != nil {
		return
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return
	}
	defer zr.Close()
	var st trafficState
	if json.NewDecoder(zr).Decode(&st) == nil && st.Since > 0 {
		t.st = st
	}
}

func (t *trafficCollector) save() {
	t.mu.Lock()
	if !t.dirty {
		t.mu.Unlock()
		return
	}
	body, err := json.Marshal(t.st)
	t.dirty = false
	t.mu.Unlock()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0o755); err != nil {
		return
	}
	tmp := t.path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return
	}
	zw := gzip.NewWriter(f)
	_, err = zw.Write(body)
	if cerr := zw.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return
	}
	_ = os.Rename(tmp, t.path)
}

type dimRow struct {
	Key   string `json:"key"`
	Up    int64  `json:"up"`
	Down  int64  `json:"down"`
	Count int    `json:"count"`
}

// report sums one period: the series at the resolution that covers it and the
// split from the dimension buckets inside it.
func (t *trafficCollector) report(period string, now time.Time) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	span := map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}[period]
	if span == 0 {
		period, span = "24h", 24*time.Hour
	}
	from := now.Add(-span).Unix()
	series := []trafficPoint{}
	resolution := 60
	src := t.st.Minutes
	if span > 24*time.Hour {
		src, resolution = t.st.Hours, 3600
	}
	var up, down int64
	for _, p := range src {
		if p.T >= from-int64(resolution) {
			series = append(series, p)
			up += p.Up
			down += p.Down
		}
	}
	buckets := t.st.DimHours
	if span > 24*time.Hour {
		buckets = t.st.DimDays
	}
	sums := map[string]map[string]*dimStat{}
	for _, b := range buckets {
		if b.T < from-int64(time.Hour/time.Second) && span <= 24*time.Hour {
			continue
		}
		if span > 24*time.Hour && b.T < from-86400 {
			continue
		}
		for dim, m := range b.Dims {
			if sums[dim] == nil {
				sums[dim] = map[string]*dimStat{}
			}
			for k, s := range m {
				acc := sums[dim][k]
				if acc == nil {
					acc = &dimStat{}
					sums[dim][k] = acc
				}
				acc.Up += s.Up
				acc.Down += s.Down
				acc.Count += s.Count
			}
		}
	}
	dims := map[string][]dimRow{}
	for dim, m := range sums {
		rows := make([]dimRow, 0, len(m))
		for k, s := range m {
			rows = append(rows, dimRow{Key: k, Up: s.Up, Down: s.Down, Count: s.Count})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].Up+rows[i].Down > rows[j].Up+rows[j].Down })
		if len(rows) > 200 {
			rows = rows[:200]
		}
		dims[dim] = rows
	}
	closed := []closedConn{}
	for i := len(t.st.Closed) - 1; i >= 0 && len(closed) < 500; i-- {
		if t.st.Closed[i].End >= from {
			closed = append(closed, t.st.Closed[i])
		}
	}
	return map[string]any{
		"period": period, "resolution": resolution, "since": t.st.Since,
		"up": up, "down": down, "series": series, "dims": dims, "closed": closed,
		"poll_seconds": int(trafficPoll / time.Second),
	}
}

func (a *app) handleCoreTraffic(w http.ResponseWriter, r *http.Request) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт трафика не запущен"})
		return
	}
	rep := traffic.report(r.URL.Query().Get("period"), time.Now())
	rep["ok"] = true
	a.writeJSON(w, http.StatusOK, rep)
}

func (a *app) handleCoreTrafficReset(w http.ResponseWriter) {
	if traffic == nil {
		a.writeJSON(w, http.StatusServiceUnavailable, response{"ok": false, "error": "учёт трафика не запущен"})
		return
	}
	traffic.mu.Lock()
	traffic.st = trafficState{Since: time.Now().Unix()}
	traffic.dirty = true
	traffic.mu.Unlock()
	traffic.save()
	a.writeJSON(w, http.StatusOK, response{"ok": true})
}
