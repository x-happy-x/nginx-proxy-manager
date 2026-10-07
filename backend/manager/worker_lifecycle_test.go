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
