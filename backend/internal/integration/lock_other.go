//go:build !linux

package integration

import "fmt"

func LockState(string) (func(), error) { return nil, fmt.Errorf("worker coordination requires Linux") }
