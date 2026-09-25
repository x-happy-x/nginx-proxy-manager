package main

import "syscall"

// directControl marks sockets like mihomo marks its own (routing-mark 255):
// XKeen's xkeen_out chain returns such packets, so they leave the Netcraze
// straight to the MikroTik instead of being redirected into mihomo.
func directControl(mark int) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, mark)
		})
		if err != nil {
			return err
		}
		return serr
	}
}
