package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Reading is bounded independently of log size to protect router memory.
const maxLogBytes int64 = 2 << 20

type logSample struct {
	ScannedLines      int            `json:"scanned_lines"`
	MalformedLines    int            `json:"malformed_lines"`
	Truncated         bool           `json:"truncated"`
	MaxBytes          int64          `json:"max_bytes"`
	Source            string         `json:"source,omitempty"`
	CoverageFrom      string         `json:"coverage_from,omitempty"`
	ResolutionSeconds int            `json:"resolution_seconds,omitempty"`
	BacklogBytes      int64          `json:"backlog_bytes,omitempty"`
	Gaps              []telemetryGap `json:"gaps,omitempty"`
	Persisted         bool           `json:"persisted,omitempty"`
	PersistenceError  string         `json:"persistence_error,omitempty"`
	P95Approximate    bool           `json:"p95_approximate,omitempty"`
}

func tailLog(path string) ([]byte, bool, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	truncated := info.Size() > maxLogBytes
	if truncated {
		if _, err = f.Seek(info.Size()-maxLogBytes, io.SeekStart); err != nil {
			return nil, false, err
		}
	}
	body, err := io.ReadAll(io.LimitReader(f, maxLogBytes))
	if truncated {
		if i := bytes.IndexByte(body, '\n'); i >= 0 {
			body = body[i+1:]
		} else {
			body = nil
		}
	}
	// Ignore an incomplete last record while nginx is writing.
	if i := bytes.LastIndexByte(body, '\n'); i >= 0 {
		body = body[:i+1]
	} else {
		body = nil
	}
	return body, truncated, err
}
func boundedLogLimit(limit int) int {
	if limit < 1 {
		return 200
	}
	if limit > 2000 {
		return 2000
	}
	return limit
}
func readLogFile(path string, limit int, contains string) ([]string, error) {
	body, _, err := tailLog(path)
	if err != nil {
		return nil, err
	}
	lines := []string{}
	for _, line := range strings.Split(string(body), "\n") {
		if line != "" && (contains == "" || strings.Contains(line, contains)) {
			lines = append(lines, line)
		}
	}
	limit = boundedLogLimit(limit)
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines, nil
}
func numeric(v any) float64 {
	n, err := strconv.ParseFloat(fmt.Sprint(v), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return n
}
func logString(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func logTraffic(item map[string]any) string {
	// Trust the literal nginx listener classification, never client headers.
	switch logString(item["traffic_source"]) {
	case "external", "local":
		return logString(item["traffic_source"])
	}
	return "unknown"
}
func readLogRecords(path string) ([]map[string]any, logSample, error) {
	body, truncated, err := tailLog(path)
	sample := logSample{Truncated: truncated, MaxBytes: maxLogBytes}
	if err != nil {
		return nil, sample, err
	}
	items := []map[string]any{}
	for _, line := range bytes.Split(body, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		sample.ScannedLines++
		var item map[string]any
		if json.Unmarshal(line, &item) != nil || item == nil {
			sample.MalformedLines++
			continue
		}
		item["traffic"] = logTraffic(item)
		item["request_time_ms"] = numeric(item["request_time"]) * 1000
		items = append(items, item)
	}
	return items, sample, nil
}
func matchesLog(item map[string]any, host, traffic, contains string, statusMin, statusMax int) bool {
	if host != "" && logString(item["host"]) != host && logString(item["route_host"]) != host {
		return false
	}
	if traffic != "" && logTraffic(item) != traffic {
		return false
	}
	status := int(numeric(item["status"]))
	if statusMin > 0 && status < statusMin || statusMax > 0 && status > statusMax {
		return false
	}
	if contains != "" {
		b, _ := json.Marshal(item)
		return strings.Contains(strings.ToLower(string(b)), strings.ToLower(contains))
	}
	return true
}
func readRouteLogs(path string, limit int, contains string, statusMin, statusMax int) ([]map[string]any, error) {
	items, _, err := readLogRecords(path)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, item := range items {
		if matchesLog(item, "", "", contains, statusMin, statusMax) {
			out = append(out, item)
		}
	}
	limit = boundedLogLimit(limit)
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}
func (a *app) handleRouteLogs(w http.ResponseWriter, r *http.Request, errorsOnly bool) {
	a.telemetryMu.Lock()
	defer a.telemetryMu.Unlock()
	q := r.URL.Query()
	limit := boundedLogLimit(atoiDefault(q.Get("limit"), 200))
	min, max := 0, 0
	if errorsOnly {
		min = 400
	} else {
		switch q.Get("status_group") {
		case "4xx":
			min, max = 400, 499
		case "5xx":
			min, max = 500, 599
		}
	}
	items, sample, err := readLogRecords(a.routeAccessLog)
	if err != nil {
		a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
		return
	}
	out := []map[string]any{}
	for _, item := range items {
		if matchesLog(item, q.Get("host"), q.Get("traffic"), q.Get("filter"), min, max) {
			out = append(out, item)
		}
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	a.writeJSON(w, 200, response{"ok": true, "items": out, "sample": sample})
}

type metricBucket struct {
	Time         string  `json:"time,omitempty"`
	Host         string  `json:"host,omitempty"`
	Requests     int     `json:"requests"`
	Errors       int     `json:"errors"`
	BytesSent    int64   `json:"bytes_sent"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	latency      float64
}

func (b *metricBucket) add(status int, sent int64, latency float64) {
	b.Requests++
	if status >= 400 {
		b.Errors++
	}
	b.BytesSent += sent
	b.latency += latency
	b.AvgLatencyMS = b.latency / float64(b.Requests)
}
func aggregateLogs(items []map[string]any, sample logSample, now time.Time, window time.Duration, host, traffic string) response {
	from := now.Add(-window)
	step := window / 60
	series := make([]metricBucket, 60)
	for i := range series {
		series[i].Time = from.Add(time.Duration(i) * step).UTC().Format(time.RFC3339)
	}
	total, c4, c5 := 0, 0, 0
	var sent int64
	latencies := []float64{}
	latencyTotal := 0.0
	trafficCounts := map[string]int{"local": 0, "external": 0, "unknown": 0}
	statuses := map[string]int{}
	hosts := map[string]*metricBucket{}
	for _, item := range items {
		at, err := time.Parse(time.RFC3339Nano, logString(item["time"]))
		if err != nil || at.Before(from) || at.After(now) || !matchesLog(item, host, traffic, "", 0, 0) {
			continue
		}
		status := int(numeric(item["status"]))
		if status < 100 || status > 599 {
			continue
		}
		latency := numeric(item["request_time"]) * 1000
		b := int64(numeric(item["bytes_sent"]))
		total++
		sent += b
		latencyTotal += latency
		latencies = append(latencies, latency)
		if status >= 400 && status < 500 {
			c4++
		}
		if status >= 500 {
			c5++
		}
		trafficCounts[logTraffic(item)]++
		statuses[strconv.Itoa(status)]++
		i := int(at.Sub(from) / step)
		if i > 59 {
			i = 59
		}
		series[i].add(status, b, latency)
		h := logString(item["route_host"])
		if h == "" {
			h = logString(item["host"])
		}
		if hosts[h] == nil {
			hosts[h] = &metricBucket{Host: h}
		}
		hosts[h].add(status, b, latency)
	}
	hostList := []metricBucket{}
	for _, h := range hosts {
		hostList = append(hostList, *h)
	}
	sort.Slice(hostList, func(i, j int) bool {
		if hostList[i].Requests == hostList[j].Requests {
			return hostList[i].Host < hostList[j].Host
		}
		return hostList[i].Requests > hostList[j].Requests
	})
	avg, p95, rate := 0.0, 0.0, 0.0
	if total > 0 {
		avg = latencyTotal / float64(total)
		rate = float64(c4+c5) / float64(total) * 100
		sort.Float64s(latencies)
		p95 = latencies[int(math.Ceil(float64(total)*0.95))-1]
	}
	return response{"window_seconds": int(window.Seconds()), "from": from.UTC().Format(time.RFC3339), "to": now.UTC().Format(time.RFC3339), "total_requests": total, "errors_4xx": c4, "errors_5xx": c5, "error_rate": rate, "bytes_sent": sent, "avg_latency_ms": avg, "p95_latency_ms": p95, "requests_per_minute": float64(total) / window.Minutes(), "traffic": trafficCounts, "status_codes": statuses, "series": series, "hosts": hostList, "sample": sample}
}
func (a *app) handleStats(w http.ResponseWriter, r *http.Request) {
	window := 24 * time.Hour
	switch r.URL.Query().Get("window") {
	case "1h":
		window = time.Hour
	case "6h":
		window = 6 * time.Hour
	case "24h", "":
	default:
		a.writeJSON(w, 400, response{"ok": false, "error": "window must be 1h, 6h or 24h"})
		return
	}
	store := a.ensureTelemetry()
	if err := store.poll(time.Now()); err != nil {
		a.writeJSON(w, 500, response{"ok": false, "error": err.Error()})
		return
	}
	a.writeJSON(w, 200, response{"ok": true, "stats": store.aggregate(time.Now(), window, r.URL.Query().Get("host"), r.URL.Query().Get("traffic"))})
}
