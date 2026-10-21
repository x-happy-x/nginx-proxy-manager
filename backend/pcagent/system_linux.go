package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func configureCommand(cmd *exec.Cmd) {}
func readFile(path string) string    { b, _ := os.ReadFile(path); return string(b) }
func number(s string) uint64         { n, _ := strconv.ParseUint(s, 10, 64); return n }
func cpuCounters(text string) (total, idle uint64, err error) {
	line := strings.SplitN(text, "\n", 2)[0]
	f := strings.Fields(line)
	if len(f) < 6 || f[0] != "cpu" {
		return 0, 0, fmt.Errorf("CPU counters unavailable")
	}
	for i, value := range f[1:] {
		if i >= 8 {
			break
		} // guest counters are already included in user/nice.
		n, parseErr := strconv.ParseUint(value, 10, 64)
		if parseErr != nil {
			return 0, 0, parseErr
		}
		total += n
		if i == 3 || i == 4 {
			idle += n
		}
	}
	return total, idle, nil
}
func parseMemory(text string) Memory {
	m := map[string]uint64{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			m[strings.TrimSuffix(f[0], ":")] = number(f[1]) * 1024
		}
	}
	available, exists := m["MemAvailable"]
	if !exists {
		available = m["MemFree"] + m["Buffers"] + m["Cached"]
	}
	if available > m["MemTotal"] {
		available = m["MemTotal"]
	}
	return Memory{Total: m["MemTotal"], Available: available, Used: m["MemTotal"] - available}
}

func defaultRouteInterfaces(ipv4, ipv6 string) map[string]bool {
	result := map[string]bool{}
	for _, line := range strings.Split(ipv4, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[1] != "00000000" {
			continue
		}
		flags, _ := strconv.ParseUint(f[3], 16, 64)
		if flags&1 != 0 && flags&0x200 == 0 {
			result[f[0]] = true
		}
	}
	for _, line := range strings.Split(ipv6, "\n") {
		f := strings.Fields(line)
		if len(f) < 10 || f[0] != strings.Repeat("0", 32) || f[1] != "00" || f[9] == "lo" {
			continue
		}
		flags, _ := strconv.ParseUint(f[8], 16, 64)
		if flags&1 != 0 && flags&0x200 == 0 {
			result[f[9]] = true
		}
	}
	return result
}
func collectSystem(ctx context.Context, run runner, s *Snapshot) {
	total1, idle1, err1 := cpuCounters(readFile("/proc/stat"))
	select {
	case <-time.After(200 * time.Millisecond):
	case <-ctx.Done():
		return
	}
	total2, idle2, err2 := cpuCounters(readFile("/proc/stat"))
	if err1 == nil && err2 == nil && total2 > total1 && idle2 >= idle1 {
		percent := 100 * (1 - float64(idle2-idle1)/float64(total2-total1))
		if percent < 0 {
			percent = 0
		}
		if percent > 100 {
			percent = 100
		}
		s.CPU.Percent = &percent
	} else {
		s.Errors = append(s.Errors, "CPU counters unavailable")
	}
	for _, line := range strings.Split(readFile("/proc/cpuinfo"), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok && (strings.TrimSpace(k) == "model name" || strings.TrimSpace(k) == "Hardware") {
			s.CPU.Model = strings.TrimSpace(v)
			break
		}
	}
	s.Memory = parseMemory(readFile("/proc/meminfo"))
	if s.Memory.Total == 0 {
		s.Errors = append(s.Errors, "Memory counters unavailable")
	}
	f := strings.Fields(readFile("/proc/uptime"))
	if len(f) > 0 {
		uptime, _ := strconv.ParseFloat(f[0], 64)
		if uptime > 0 {
			s.Uptime = uint64(uptime)
		}
	}
	seen := map[string]bool{}
	decodeMount := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`)
	for _, line := range strings.Split(readFile("/proc/mounts"), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		path := decodeMount.Replace(f[1])
		if seen[path] {
			continue
		}
		switch f[2] {
		case "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk":
		case "overlay":
			if path != "/" {
				continue
			}
		default:
			continue
		}
		var stat syscall.Statfs_t
		if syscall.Statfs(path, &stat) != nil {
			continue
		}
		total, free := stat.Blocks*uint64(stat.Bsize), stat.Bavail*uint64(stat.Bsize)
		if free > total {
			free = total
		}
		s.Disks = append(s.Disks, Disk{path, total, total - free, free})
		seen[path] = true
	}
	uplinks := defaultRouteInterfaces(readFile("/proc/net/route"), readFile("/proc/net/ipv6_route"))
	for _, line := range strings.Split(readFile("/proc/net/dev"), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 16 {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" {
			continue
		}
		s.Network = append(s.Network, Network{Name: name, RX: number(f[0]), TX: number(f[8]), Aggregate: uplinks[name]})
	}
}
