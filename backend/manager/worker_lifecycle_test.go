package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkerCancellationStopsAndJoinsSampler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	previous := workerContext
	workerContext = ctx
	defer func() { workerContext = previous }()
	var calls atomic.Int32
	started := make(chan struct{})
	every(time.Hour, func() { calls.Add(1); close(started) })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sampler did not start")
	}
	cancel()
	done := make(chan struct{})
	go func() { workerTasks.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sampler ignored cancellation")
	}
	if calls.Load() != 1 {
		t.Fatal("sampler ran after cancellation")
	}
}

func TestAnalyzerWithoutVPNDoesNotProbeProxy(t *testing.T) {
	t.Setenv("HOMENET_PLATFORM_STATE", t.TempDir())
	result, err := analyze("127.0.0.1", []string{"mihomo"})
	if err != nil || len(result.Paths) != 1 || result.Paths[0].Verdict != "skip" {
		t.Fatalf("missing optional VPN must be skipped: %+v %v", result, err)
	}
	var summary analysis
	summarize(&summary, map[string]probePath{"direct": {Verdict: "ok"}, "mihomo": {Verdict: "skip"}})
	if summary.Verdict != "open" {
		t.Fatalf("missing VPN must not report proxy failure: %+v", summary)
	}
}
