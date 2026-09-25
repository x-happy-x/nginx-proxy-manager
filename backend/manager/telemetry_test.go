package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func telemetryLine(at time.Time, host, traffic string, status int, latency float64) string {
	body, _ := json.Marshal(map[string]any{"time": at.UTC().Format(time.RFC3339Nano), "route_host": host, "host": "untrusted.invalid", "traffic_source": traffic, "status": fmt.Sprint(status), "bytes_sent": "1234", "request_time": fmt.Sprint(latency)})
	return string(body) + "\n"
}
func newTestTelemetry(t *testing.T, now time.Time) *telemetryStore {
	t.Helper()
	root := t.TempDir()
	s := newTelemetryStore(filepath.Join(root, "route.log"), filepath.Join(root, "stats.gz"), now)
	t.Cleanup(func() {
		if s.file != nil {
			s.file.Close()
		}
	})
	return s
}
func appendTelemetry(t *testing.T, path, body string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(body); err != nil {
		t.Fatal(err)
	}
}
func telemetryTotal(t *testing.T, s *telemetryStore, now time.Time) int64 {
	t.Helper()
	result := s.aggregate(now, 24*time.Hour, "", "")
	return result["total_requests"].(int64)
}

func TestTelemetryCheckpointRestartDoesNotDoubleCount(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	s := newTestTelemetry(t, now)
	appendTelemetry(t, s.path, telemetryLine(now.Add(-time.Minute), "sub.local", "local", 200, 0.010))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, s, now) != 1 {
		t.Fatal("initial request missing")
	}
	appendTelemetry(t, s.path, telemetryLine(now, "sub.local", "external", 502, 0.300))
	restarted := newTelemetryStore(s.path, s.statePath, now.Add(time.Second))
	defer func() {
		if restarted.file != nil {
			restarted.file.Close()
		}
	}()
	if err := restarted.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := telemetryTotal(t, restarted, now.Add(time.Second)); got != 2 {
		t.Fatalf("restart count %d", got)
	}
	if err := restarted.poll(now.Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, restarted, now.Add(2*time.Second)) != 2 {
		t.Fatal("poll counted a record twice")
	}
	stats := restarted.aggregate(now.Add(time.Second), time.Hour, "sub.local", "external")
	if stats["total_requests"].(int64) != 1 || stats["errors_5xx"].(int64) != 1 {
		t.Fatal("filter/error aggregation", stats)
	}
}

func TestTelemetryPartialLineCommittedOnlyAfterNewline(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	line := telemetryLine(now, "sub.local", "local", 200, .02)
	appendTelemetry(t, s.path, line[:len(line)-1])
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, s, now) != 0 || s.checkpoint.Offset != 0 {
		t.Fatal("partial record counted")
	}
	appendTelemetry(t, s.path, "\n")
	if err := s.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, s, now.Add(time.Second)) != 1 {
		t.Fatal("completed record missing")
	}
}

func TestTelemetryRotationDrainsOldFileAndKeepsHistory(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	appendTelemetry(t, s.path, telemetryLine(now.Add(-time.Minute), "old.local", "local", 200, .01))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	appendTelemetry(t, s.path, telemetryLine(now, "old.local", "local", 201, .02))
	// Windows denies renaming an open file; Linux exercises the held-descriptor
	// path, while Windows exercises the equivalent checkpoint/.1 fallback.
	if os.PathSeparator == '\\' {
		s.file.Close()
		s.file = nil
	}
	if err := os.Rename(s.path, s.path+".1"); err != nil {
		t.Fatal(err)
	}
	appendTelemetry(t, s.path, telemetryLine(now, "new.local", "external", 500, .03))
	if err := s.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := telemetryTotal(t, s, now.Add(time.Second)); got != 3 {
		t.Fatalf("rotation lost records: %d", got)
	}
	if len(s.checkpoint.Gaps) != 0 {
		t.Fatal("lossless rotation incorrectly reported a gap", s.checkpoint.Gaps)
	}
}

func TestTelemetryRestartFindsRotatedCheckpoint(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	appendTelemetry(t, s.path, telemetryLine(now, "old.local", "local", 200, .01))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	appendTelemetry(t, s.path, telemetryLine(now, "old.local", "local", 201, .02))
	s.file.Close()
	s.file = nil
	if err := os.Rename(s.path, s.path+".1"); err != nil {
		t.Fatal(err)
	}
	appendTelemetry(t, s.path, telemetryLine(now, "new.local", "external", 500, .03))
	restarted := newTelemetryStore(s.path, s.statePath, now.Add(time.Second))
	defer func() {
		if restarted.file != nil {
			restarted.file.Close()
		}
	}()
	if err := restarted.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := telemetryTotal(t, restarted, now.Add(time.Second)); got != 3 {
		t.Fatalf("rotated restart total %d", got)
	}
}

func TestTelemetryCopyTruncateRetainsPreviousBuckets(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	old := telemetryLine(now.Add(-time.Minute), "old.local", "local", 200, .01)
	appendTelemetry(t, s.path, old)
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	old += telemetryLine(now, "old.local", "local", 201, .02)
	if err := os.WriteFile(s.path+".1", []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path, []byte(telemetryLine(now, "new.local", "external", 500, .03)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := telemetryTotal(t, s, now.Add(time.Second)); got != 3 {
		t.Fatalf("copytruncate count %d", got)
	}
}

func TestTelemetryMissingRotatedTailDisclosesGap(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	appendTelemetry(t, s.path, telemetryLine(now.Add(-time.Minute), "old.local", "local", 200, .01))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path, []byte(telemetryLine(now, "new.local", "local", 200, .04)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, s, now.Add(time.Second)) != 2 {
		t.Fatal("history lost after truncation")
	}
	sample := s.aggregate(now, time.Hour, "", "")["sample"].(logSample)
	if len(sample.Gaps) == 0 || !sample.Truncated {
		t.Fatal("missing tail not disclosed")
	}
}

func TestTelemetryMalformedLongRecordsAndRetention(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	appendTelemetry(t, s.path, "invalid json\n"+strings.Repeat("x", 200000)+"\n"+telemetryLine(now.Add(-25*time.Hour), "old.local", "local", 200, .01)+telemetryLine(now, "sub.local", "external", 200, .072))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	if telemetryTotal(t, s, now) != 1 {
		t.Fatal("valid record after large malformed line was lost")
	}
	if s.checkpoint.Malformed != 2 {
		t.Fatalf("malformed count %d", s.checkpoint.Malformed)
	}
	stats := s.aggregate(now, time.Hour, "", "")
	if stats["p95_latency_ms"].(float64) < 72 || stats["p95_approximate"] != true {
		t.Fatal("P95 estimate incorrectly represented")
	}
	if telemetryTotal(t, s, now.Add(25*time.Hour)) != 0 || len(s.buckets) != 0 {
		t.Fatal("old buckets not pruned")
	}
}

func TestTelemetryReadsMoreThanTailLimitIncrementally(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	line := telemetryLine(now, "sub.local", "local", 200, .01)
	count := int(telemetryBatchBytes)/len(line) + 20
	appendTelemetry(t, s.path, strings.Repeat(line, count))
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	first := telemetryTotal(t, s, now)
	if first <= 0 || first >= int64(count) {
		t.Fatalf("poll was not bounded: %d of %d", first, count)
	}
	if err := s.poll(now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := telemetryTotal(t, s, now.Add(time.Second)); got != int64(count) {
		t.Fatalf("batch boundary lost/duplicated records: %d want %d", got, count)
	}
}

func TestTelemetryMissingLogDoesNotCreateSourceOrFail(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	if err := s.poll(now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("collector created access log")
	}
}

func TestTelemetryFixedMemoryCardinalityLimits(t *testing.T) {
	now := time.Now()
	s := newTestTelemetry(t, now)
	for i := 0; i < 300; i++ {
		s.ingest([]byte(telemetryLine(now, fmt.Sprintf("host-%d.local", i), "local", 200, .01)), now)
	}
	if len(s.hostNames) != 256 || len(s.buckets) != 257 {
		t.Fatalf("host cardinality not bounded: %d %d", len(s.hostNames), len(s.buckets))
	}
	if telemetryTotal(t, s, now) != 300 {
		t.Fatal("grouping extra hosts lost requests")
	}
	for status := 100; status <= 599; status++ {
		s.ingest([]byte(telemetryLine(now, "host-0.local", "local", status, .01)), now)
	}
	bucket := s.buckets[telemetryKey{Minute: now.Unix() / 60, Host: "host-0.local", Traffic: "local"}]
	if len(bucket.Statuses) != telemetryMaxStatuses || bucket.OtherStatuses == 0 {
		t.Fatal("status cardinality not bounded")
	}
	for len(s.buckets) < telemetryMaxBuckets {
		s.buckets[telemetryKey{Minute: int64(len(s.buckets)), Host: "padding", Traffic: "local"}] = &telemetryBucket{Minute: now.Unix() / 60}
	}
	s.ingest([]byte(telemetryLine(now.Add(-time.Minute), "host-0.local", "external", 200, .01)), now)
	if len(s.buckets) != telemetryMaxBuckets {
		t.Fatal("bucket limit exceeded")
	}
	if len(s.checkpoint.Gaps) == 0 {
		t.Fatal("cardinality limit not disclosed")
	}
}
