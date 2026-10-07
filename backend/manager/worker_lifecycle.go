package main

import (
	"context"
	"sync"
	"time"
)

// Every worker is a separate process: no mutable module state is shared with Core.
// The legacy executable keeps a background context until its migration is complete.
var workerContext = context.Background()
var workerTasks sync.WaitGroup

func managedGo(fn func()) {
	workerTasks.Add(1)
	go func() { defer workerTasks.Done(); fn() }()
}
func workerWait(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-workerContext.Done():
		return false
	case <-timer.C:
		return true
	}
}
func every(interval time.Duration, fn func()) {
	managedGo(func() {
		for workerContext.Err() == nil {
			fn()
			if !workerWait(interval) {
				return
			}
		}
	})
}
