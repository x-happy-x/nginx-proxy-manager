package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

func configureCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var getSystemTimes = kernel32.NewProc("GetSystemTimes")
var globalMemoryStatus = kernel32.NewProc("GlobalMemoryStatusEx")
var getTickCount = kernel32.NewProc("GetTickCount64")
var getLogicalDrives = kernel32.NewProc("GetLogicalDrives")
var getDriveType = kernel32.NewProc("GetDriveTypeW")
var getDiskFree = kernel32.NewProc("GetDiskFreeSpaceExW")

type memoryStatus struct {
	Length, Load                                                                                         uint32
	TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual uint64
}

func windowsCPUTimes() (total, idle uint64, ok bool) {
	var idleTime, kernelTime, userTime syscall.Filetime
	r, _, _ := getSystemTimes.Call(uintptr(unsafe.Pointer(&idleTime)), uintptr(unsafe.Pointer(&kernelTime)), uintptr(unsafe.Pointer(&userTime)))
	convert := func(t syscall.Filetime) uint64 { return uint64(t.HighDateTime)<<32 | uint64(t.LowDateTime) }
	return convert(kernelTime) + convert(userTime), convert(idleTime), r != 0
}
func collectSystem(ctx context.Context, run runner, s *Snapshot) {
	total1, idle1, ok1 := windowsCPUTimes()
	select {
	case <-time.After(200 * time.Millisecond):
	case <-ctx.Done():
		return
	}
	total2, idle2, ok2 := windowsCPUTimes()
	if ok1 && ok2 && total2 > total1 && idle2 >= idle1 {
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
	s.CPU.Model = os.Getenv("PROCESSOR_IDENTIFIER")
	memory := memoryStatus{}
	memory.Length = uint32(unsafe.Sizeof(memory))
	r, _, _ := globalMemoryStatus.Call(uintptr(unsafe.Pointer(&memory)))
	if r != 0 {
		s.Memory = Memory{Total: memory.TotalPhys, Available: memory.AvailPhys, Used: memory.TotalPhys - memory.AvailPhys}
	} else {
		s.Errors = append(s.Errors, "Memory counters unavailable")
	}
	ticks, _, _ := getTickCount.Call()
	s.Uptime = uint64(ticks) / 1000
	drives, _, _ := getLogicalDrives.Call()
	for i := 0; i < 26; i++ {
		if drives&(1<<i) == 0 {
			continue
		}
		path := string(rune('A'+i)) + ":\\"
		utf, _ := syscall.UTF16PtrFromString(path)
		kind, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(utf)))
		if kind != 3 {
			continue
		} // fixed disks only; no network probes
		var available, total, free uint64
		r, _, _ := getDiskFree.Call(uintptr(unsafe.Pointer(utf)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free)))
		if r != 0 && available <= total {
			s.Disks = append(s.Disks, Disk{path, total, total - available, available})
		}
	}
	// This script is constant. No request data is ever embedded in PowerShell.
	const networkScript = `$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $uplinks=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InterfaceAlias -Unique); $items=@(Get-NetAdapterStatistics | ForEach-Object { [pscustomobject]@{name=$_.Name;rx_bytes=$_.ReceivedBytes;tx_bytes=$_.SentBytes;aggregate=($uplinks -contains $_.Name)} }); ConvertTo-Json -InputObject $items -Compress`
	probe, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	b, err := run(probe, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", networkScript)
	if err == nil {
		err = json.Unmarshal([]byte(decodeOutput(b)), &s.Network)
	}
	if err != nil {
		s.Errors = append(s.Errors, "Network counters unavailable: "+err.Error())
	}
}
