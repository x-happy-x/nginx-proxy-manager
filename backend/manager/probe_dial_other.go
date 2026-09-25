//go:build !linux

package main

import "syscall"

func directControl(int) func(network, address string, c syscall.RawConn) error {
	return nil
}
