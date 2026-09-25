package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

const telemetryBatchBytes int64 = 4 << 20
const telemetryMaxBuckets = 32000
const telemetryMaxStatuses = 32
const telemetryStateVersion = 1

// Fixed bins bound memory regardless of request count. P95 is the upper bound
// of its bin; the API labels this estimate explicitly.
var latencyBounds = [...]float64{0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 65, 90, 125, 180, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 6000, 9000, 13000, 20000, 30000, 60000, 120000, 300000, math.MaxFloat64}

type telemetryGap struct {
	At     string `json:"at"`
	Reason string `json:"reason"`
}
type telemetryKey struct {
	Minute        int64
	Host, Traffic string
}
type telemetryBucket struct {
	Minute        int64          `json:"minute"`
	Host          string         `json:"host"`
	Traffic       string         `json:"traffic"`
	Requests      int64          `json:"requests"`
	Errors4       int64          `json:"errors_4xx"`
	Errors5       int64          `json:"errors_5xx"`
	Bytes         int64          `json:"bytes"`
	LatencySum    float64        `json:"latency_sum"`
	LatencyMax    float64        `json:"latency_max"`
	Histogram     [32]uint32     `json:"histogram"`
	Statuses      map[int]uint32 `json:"statuses"`
	OtherStatuses int64          `json:"other_statuses,omitempty"`
}
type telemetryCheckpoint struct {
	Version      int            `json:"version"`
	LogPath      string         `json:"log_path"`
	Offset       int64          `json:"offset"`
	PrefixLength int            `json:"prefix_length"`
	PrefixHash   string         `json:"prefix_hash"`
	AnchorHash   string         `json:"anchor_hash"`
	Discarding   bool           `json:"discarding"`
	CoverageFrom time.Time      `json:"coverage_from"`
	Scanned      int            `json:"scanned"`
	Malformed    int            `json:"malformed"`
	Gaps         []telemetryGap `json:"gaps"`
	SavedAt      time.Time      `json:"saved_at"`
}
type telemetryStore struct {
	mu              sync.Mutex
	path, statePath string
	file            *os.File
	checkpoint      telemetryCheckpoint
	buckets         map[telemetryKey]*telemetryBucket
	lastPersist     time.Time
	persistError    string
	backlog         int64
	dirty           bool
	hostNames       map[string]string
}

func (a *app) ensureTelemetry() *telemetryStore {
	a.telemetryMu.Lock()
	defer a.telemetryMu.Unlock()
	if a.telemetry == nil {
		a.telemetry = newTelemetryStore(a.routeAccessLog, getenv("STATS_STATE_PATH", a.routeAccessLog+".stats.gz"), time.Now())
	}
	return a.telemetry
}
func (a *app) startTelemetry() {
	store := a.ensureTelemetry()
	go func() {
		_ = store.poll(time.Now())
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for now := range ticker.C {
			_ = store.poll(now)
		}
	}()
}
func newTelemetryStore(path, statePath string, now time.Time) *telemetryStore {
	s := &telemetryStore{path: path, statePath: statePath, buckets: map[telemetryKey]*telemetryBucket{}, hostNames: map[string]string{}, checkpoint: telemetryCheckpoint{Version: telemetryStateVersion, LogPath: path, CoverageFrom: now}}
	if err := s.load(now); err != nil && !os.IsNotExist(err) {
		s.buckets = map[telemetryKey]*telemetryBucket{}
		s.hostNames = map[string]string{}
		s.lastPersist = time.Time{}
		s.checkpoint = telemetryCheckpoint{Version: telemetryStateVersion, LogPath: path, CoverageFrom: now}
		s.gap(now, "Statistics checkpoint could not be read; rebuilding from available logs")
	}
	return s
}
func (s *telemetryStore) gap(now time.Time, reason string) {
	if len(s.checkpoint.Gaps) > 0 {
		last := s.checkpoint.Gaps[len(s.checkpoint.Gaps)-1]
		at, _ := time.Parse(time.RFC3339, last.At)
		if last.Reason == reason && now.Sub(at) < time.Minute {
			return
		}
	}
	s.checkpoint.Gaps = append(s.checkpoint.Gaps, telemetryGap{At: now.UTC().Format(time.RFC3339), Reason: reason})
	if len(s.checkpoint.Gaps) > 64 {
		s.checkpoint.Gaps = s.checkpoint.Gaps[len(s.checkpoint.Gaps)-64:]
	}
	s.dirty = true
}
func (s *telemetryStore) prune(now time.Time) {
	cutoff := now.Add(-24*time.Hour-time.Minute).Unix() / 60
	for key := range s.buckets {
		if key.Minute < cutoff {
			delete(s.buckets, key)
			s.dirty = true
		}
	}
	gaps := s.checkpoint.Gaps[:0]
	for _, gap := range s.checkpoint.Gaps {
		at, err := time.Parse(time.RFC3339, gap.At)
		if err == nil && at.After(now.Add(-24*time.Hour)) {
			gaps = append(gaps, gap)
		}
	}
	s.checkpoint.Gaps = gaps
}
func hashBytes(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }
func fileHash(f *os.File, offset int64, length int) (string, error) {
	body := make([]byte, length)
	_, err := f.ReadAt(body, offset)
	if err != nil {
		return "", err
	}
	return hashBytes(body), nil
}
func (s *telemetryStore) matchesCheckpoint(f *os.File) bool {
	info, err := f.Stat()
	if err != nil || info.Size() < s.checkpoint.Offset {
		return false
	}
	if s.checkpoint.PrefixLength > 0 {
		hash, err := fileHash(f, 0, s.checkpoint.PrefixLength)
		if err != nil || hash != s.checkpoint.PrefixHash {
			return false
		}
	}
	if s.checkpoint.Offset > 0 && s.checkpoint.AnchorHash != "" {
		length := int64(128)
		if s.checkpoint.Offset < length {
			length = s.checkpoint.Offset
		}
		hash, err := fileHash(f, s.checkpoint.Offset-length, int(length))
		if err != nil || hash != s.checkpoint.AnchorHash {
			return false
		}
	}
	return true
}
func (s *telemetryStore) updateFingerprint() error {
	if s.file == nil {
		return nil
	}
	if s.checkpoint.PrefixLength == 0 && s.checkpoint.Offset > 0 {
		length := s.checkpoint.Offset
		if length > 256 {
			length = 256
		}
		hash, err := fileHash(s.file, 0, int(length))
		if err != nil {
			return err
		}
		s.checkpoint.PrefixLength, s.checkpoint.PrefixHash = int(length), hash
	}
	if s.checkpoint.Offset > 0 {
		length := int64(128)
		if s.checkpoint.Offset < length {
			length = s.checkpoint.Offset
		}
		hash, err := fileHash(s.file, s.checkpoint.Offset-length, int(length))
		if err != nil {
			return err
		}
		s.checkpoint.AnchorHash = hash
	}
	return nil
}
func (s *telemetryStore) resetCursor() {
	s.checkpoint.Offset = 0
	s.checkpoint.PrefixLength = 0
	s.checkpoint.PrefixHash = ""
	s.checkpoint.AnchorHash = ""
	s.checkpoint.Discarding = false
}

func (s *telemetryStore) internHost(host string, now time.Time) string {
	if existing, ok := s.hostNames[host]; ok {
		return existing
	}
	if len(s.hostNames) >= 256 {
		s.gap(now, "Statistics host limit reached; extra hosts are grouped as other")
		return "other"
	}
	s.hostNames[host] = host
	return host
}
func (s *telemetryStore) findRotated() *os.File {
	entries, err := os.ReadDir(filepath.Dir(s.path))
	if err != nil {
		return nil
	}
	prefix := filepath.Base(s.path) + "."
	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) || strings.HasSuffix(entry.Name(), ".gz") {
			continue
		}
		checked++
		if checked > 32 {
			break
		}
		f, err := os.Open(filepath.Join(filepath.Dir(s.path), entry.Name()))
		if err == nil {
			if s.matchesCheckpoint(f) {
				return f
			}
			f.Close()
		}
	}
	return nil
}
func (s *telemetryStore) openLog(now time.Time) error {
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		s.backlog = 0
		return nil
	}
	if err != nil {
		return err
	}
	if s.checkpoint.Offset > 0 && !s.matchesCheckpoint(f) {
		if old := s.findRotated(); old != nil {
			f.Close()
			s.file = old
			return nil
		}
		s.gap(now, "A rotated or truncated log tail was unavailable; saved request totals are retained")
		s.resetCursor()
	}
	s.file = f
	return nil
}

// A number may be emitted as a JSON string by nginx or as a number by imports.
type telemetryNumber float64

func (n *telemetryNumber) UnmarshalJSON(body []byte) error {
	if len(body) > 0 && body[0] == '"' {
		var value string
		if err := json.Unmarshal(body, &value); err != nil {
			return err
		}
		body = []byte(value)
	}
	value, err := strconv.ParseFloat(string(body), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return fmt.Errorf("invalid numeric log field")
	}
	*n = telemetryNumber(value)
	return nil
}

type telemetryRecord struct {
	Time      string          `json:"time"`
	Host      string          `json:"host"`
	RouteHost string          `json:"route_host"`
	Traffic   string          `json:"traffic_source"`
	Status    telemetryNumber `json:"status"`
	Bytes     telemetryNumber `json:"bytes_sent"`
	Latency   telemetryNumber `json:"request_time"`
}

func (s *telemetryStore) ingest(line []byte, now time.Time) {
	s.checkpoint.Scanned++
	s.dirty = true
	var record telemetryRecord
	if json.Unmarshal(line, &record) != nil {
		s.checkpoint.Malformed++
		return
	}
	at, err := time.Parse(time.RFC3339Nano, record.Time)
	if err != nil || at.After(now.Add(time.Minute)) {
		s.checkpoint.Malformed++
		return
	}
	if at.Before(now.Add(-24*time.Hour - time.Minute)) {
		return
	}
	status := int(record.Status)
	if status < 100 || status > 599 || float64(status) != float64(record.Status) || record.Bytes < 0 || float64(record.Bytes) >= float64(math.MaxInt64) || record.Latency < 0 {
		s.checkpoint.Malformed++
		return
	}
	host := record.RouteHost
	if host == "" {
		host = record.Host
	}
	if !schema.ValidHostname(host) {
		host = "unknown"
	}
	host = s.internHost(host, now)
	traffic := record.Traffic
	if traffic != "local" && traffic != "external" {
		traffic = "unknown"
	}
	key := telemetryKey{Minute: at.Unix() / 60, Host: host, Traffic: traffic}
	bucket := s.buckets[key]
	if bucket == nil {
		if len(s.buckets) >= telemetryMaxBuckets {
			s.gap(now, "Statistics bucket limit reached; some high-cardinality traffic is not included")
			return
		}
		bucket = &telemetryBucket{Minute: key.Minute, Host: host, Traffic: traffic, Statuses: map[int]uint32{}}
		s.buckets[key] = bucket
	}
	latency := float64(record.Latency) * 1000
	bucket.Requests++
	bucket.Bytes += int64(record.Bytes)
	bucket.LatencySum += latency
	if latency > bucket.LatencyMax {
		bucket.LatencyMax = latency
	}
	if status >= 400 && status < 500 {
		bucket.Errors4++
	}
	if status >= 500 {
		bucket.Errors5++
	}
	if _, ok := bucket.Statuses[status]; ok || len(bucket.Statuses) < telemetryMaxStatuses {
		bucket.Statuses[status]++
	} else {
		bucket.OtherStatuses++
	}
	for i, upper := range latencyBounds {
		if latency <= upper {
			bucket.Histogram[i]++
			break
		}
	}
	if at.Before(s.checkpoint.CoverageFrom) {
		s.checkpoint.CoverageFrom = at
	}
}

func (s *telemetryStore) poll(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	if s.file == nil {
		if err := s.openLog(now); err != nil {
			return err
		}
	}
	if s.file == nil {
		return nil
	}
	if !s.matchesCheckpoint(s.file) {
		if old := s.findRotated(); old != nil {
			s.file.Close()
			s.file = old
		} else {
			s.gap(now, "Log truncation overtook collection; saved request totals are retained")
			s.resetCursor()
		}
	}
	remaining := telemetryBatchBytes
	for remaining > 0 && s.file != nil {
		if _, err := s.file.Seek(s.checkpoint.Offset, io.SeekStart); err != nil {
			return err
		}
		reader := bufio.NewReaderSize(io.LimitReader(s.file, remaining), 64<<10)
		consumed := int64(0)
		for {
			line, err := reader.ReadSlice('\n')
			consumed += int64(len(line))
			if err == bufio.ErrBufferFull {
				s.checkpoint.Discarding = true
				s.checkpoint.Offset += int64(len(line))
				s.dirty = true
				continue
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			s.checkpoint.Offset += int64(len(line))
			if s.checkpoint.Discarding {
				s.checkpoint.Discarding = false
				s.checkpoint.Scanned++
				s.checkpoint.Malformed++
				s.dirty = true
			} else if len(bytes.TrimSpace(line)) > 0 {
				s.ingest(line, now)
			}
		}
		remaining -= consumed
		if err := s.updateFingerprint(); err != nil {
			return err
		}
		info, err := s.file.Stat()
		if err != nil {
			return err
		}
		s.backlog = info.Size() - s.checkpoint.Offset
		if s.backlog < 0 {
			s.backlog = 0
		}
		current, err := os.Stat(s.path)
		if err == nil && !os.SameFile(info, current) && s.checkpoint.Offset >= info.Size() {
			s.file.Close()
			s.file = nil
			s.resetCursor()
			if err := s.openLog(now); err != nil {
				return err
			}
			continue
		}
		break
	}
	if s.dirty && (s.lastPersist.IsZero() || now.Sub(s.lastPersist) >= time.Minute) {
		if err := s.persist(now); err != nil {
			s.persistError = err.Error()
		} else {
			s.persistError = ""
			s.lastPersist = now
			s.dirty = false
		}
	}
	return nil
}

func (s *telemetryStore) persist(now time.Time) error {
	if s.statePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.statePath), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.statePath), ".stats-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	zip := gzip.NewWriter(f)
	writer := bufio.NewWriterSize(zip, 64<<10)
	meta := s.checkpoint
	meta.SavedAt = now
	write := func(value any) error {
		body, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if _, err := writer.Write(body); err != nil {
			return err
		}
		return writer.WriteByte('\n')
	}
	if err := write(meta); err != nil {
		zip.Close()
		f.Close()
		return err
	}
	for _, bucket := range s.buckets {
		if err := write(bucket); err != nil {
			zip.Close()
			f.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		zip.Close()
		f.Close()
		return err
	}
	if err := zip.Close(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), s.statePath); err != nil {
		return err
	}
	s.checkpoint.SavedAt = now
	return nil
}
func (s *telemetryStore) load(now time.Time) error {
	f, err := os.Open(s.statePath)
	if err != nil {
		return err
	}
	defer f.Close()
	zip, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer zip.Close()
	limited := &io.LimitedReader{R: zip, N: (64 << 20) + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	if !scanner.Scan() {
		return fmt.Errorf("empty statistics checkpoint")
	}
	var meta telemetryCheckpoint
	if err := json.Unmarshal(scanner.Bytes(), &meta); err != nil {
		return err
	}
	if meta.Version != telemetryStateVersion || meta.LogPath != s.path || meta.Offset < 0 || meta.PrefixLength < 0 || meta.PrefixLength > 256 {
		return fmt.Errorf("incompatible statistics checkpoint")
	}
	s.checkpoint = meta
	s.lastPersist = meta.SavedAt
	for scanner.Scan() {
		var bucket telemetryBucket
		if err := json.Unmarshal(scanner.Bytes(), &bucket); err != nil {
			return err
		}
		if len(s.buckets) >= telemetryMaxBuckets {
			return fmt.Errorf("statistics checkpoint exceeds bucket limit")
		}
		if bucket.Minute < (now.Add(-24*time.Hour-time.Minute).Unix() / 60) {
			continue
		}
		if len(bucket.Statuses) > telemetryMaxStatuses {
			return fmt.Errorf("invalid checkpoint status cardinality")
		}
		bucket.Host = s.internHost(bucket.Host, now)
		s.buckets[telemetryKey{Minute: bucket.Minute, Host: bucket.Host, Traffic: bucket.Traffic}] = &bucket
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if limited.N <= 0 {
		return fmt.Errorf("statistics checkpoint exceeds size limit")
	}
	s.prune(now)
	return nil
}

func (s *telemetryStore) aggregate(now time.Time, window time.Duration, host, traffic string) response {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)
	from := now.Truncate(time.Minute).Add(-window)
	step := window / 60
	series := make([]metricBucket, 60)
	for i := range series {
		series[i].Time = from.Add(time.Duration(i) * step).UTC().Format(time.RFC3339)
	}
	total, c4, c5 := int64(0), int64(0), int64(0)
	var sent int64
	latencyTotal, maxLatency := 0.0, 0.0
	histogram := [32]uint64{}
	trafficCounts := map[string]int64{"local": 0, "external": 0, "unknown": 0}
	statuses := map[string]int64{}
	hosts := map[string]*metricBucket{}
	add := func(to *metricBucket, from *telemetryBucket) {
		to.Requests += int(from.Requests)
		to.Errors += int(from.Errors4 + from.Errors5)
		to.BytesSent += from.Bytes
		to.latency += from.LatencySum
		if to.Requests > 0 {
			to.AvgLatencyMS = to.latency / float64(to.Requests)
		}
	}
	for _, bucket := range s.buckets {
		at := time.Unix(bucket.Minute*60, 0)
		if at.Before(from) || at.After(now) || host != "" && bucket.Host != host || traffic != "" && bucket.Traffic != traffic {
			continue
		}
		total += bucket.Requests
		c4 += bucket.Errors4
		c5 += bucket.Errors5
		sent += bucket.Bytes
		latencyTotal += bucket.LatencySum
		if bucket.LatencyMax > maxLatency {
			maxLatency = bucket.LatencyMax
		}
		trafficCounts[bucket.Traffic] += bucket.Requests
		for status, count := range bucket.Statuses {
			statuses[strconv.Itoa(status)] += int64(count)
		}
		if bucket.OtherStatuses > 0 {
			statuses["other"] += bucket.OtherStatuses
		}
		for i, count := range bucket.Histogram {
			histogram[i] += uint64(count)
		}
		i := int(at.Sub(from) / step)
		if i > 59 {
			i = 59
		}
		add(&series[i], bucket)
		if hosts[bucket.Host] == nil {
			hosts[bucket.Host] = &metricBucket{Host: bucket.Host}
		}
		add(hosts[bucket.Host], bucket)
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
		target := uint64(math.Ceil(float64(total) * 0.95))
		var seen uint64
		for i, count := range histogram {
			seen += count
			if seen >= target {
				p95 = math.Min(latencyBounds[i], maxLatency)
				break
			}
		}
	}
	gaps := []telemetryGap{}
	for _, gap := range s.checkpoint.Gaps {
		at, _ := time.Parse(time.RFC3339, gap.At)
		if !at.Before(from) {
			gaps = append(gaps, gap)
		}
	}
	sample := logSample{Source: "persistent", ScannedLines: s.checkpoint.Scanned, MalformedLines: s.checkpoint.Malformed, MaxBytes: telemetryBatchBytes, CoverageFrom: s.checkpoint.CoverageFrom.UTC().Format(time.RFC3339), ResolutionSeconds: 60, BacklogBytes: s.backlog, Gaps: gaps, Persisted: !s.checkpoint.SavedAt.IsZero(), PersistenceError: s.persistError, P95Approximate: true, Truncated: len(gaps) > 0 || s.checkpoint.CoverageFrom.After(from) || s.backlog > 0}
	return response{"window_seconds": int(window.Seconds()), "from": from.UTC().Format(time.RFC3339), "to": now.UTC().Format(time.RFC3339), "total_requests": total, "errors_4xx": c4, "errors_5xx": c5, "error_rate": rate, "bytes_sent": sent, "avg_latency_ms": avg, "p95_latency_ms": p95, "p95_approximate": true, "requests_per_minute": float64(total) / window.Minutes(), "traffic": trafficCounts, "status_codes": statuses, "series": series, "hosts": hostList, "sample": sample}
}
