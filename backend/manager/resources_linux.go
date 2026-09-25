package main

import "syscall"

func readDisk(path string) (diskUsage, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil || st.Blocks == 0 {
		return diskUsage{}, false
	}
	size := int64(st.Bsize)
	return diskUsage{Path: path, Total: int64(st.Blocks) * size, Free: int64(st.Bavail) * size}, true
}
