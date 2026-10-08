//go:build linux

package integration

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// One coordinator owns a state directory, including offline recovery. flock is
// released by the kernel on crash and therefore does not leave a stale lock.
func LockState(state string) (func(), error) {
	if err := os.MkdirAll(state, 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(state, "coordinator.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("Core or offline recovery already owns this state directory")
	}
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
}
