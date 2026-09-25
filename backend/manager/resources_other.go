//go:build !linux

package main

// The resource monitor reads /proc and only runs on the router.
func readDisk(path string) (diskUsage, bool) {
	return diskUsage{}, false
}
