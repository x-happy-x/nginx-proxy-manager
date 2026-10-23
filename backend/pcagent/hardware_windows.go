package main

import (
	"context"
	_ "embed"
	"encoding/binary"
	"fmt"
	"sync"
	"unsafe"
)

//go:embed hardware_windows.ps1
var hardwareWindowsScript string

func platformHardware(ctx context.Context, run runner) map[string]any {
	h := map[string]any{"source": "Windows CIM", "os": "windows"}
	status := map[string]any{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	// Slow or inaccessible providers do not erase data from other providers.
	for _, section := range []string{"system", "storage", "devices", "sensors"} {
		wg.Add(1)
		go func(section string) {
			defer wg.Done()
			b, err := run(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$section='"+section+"';\n"+hardwareWindowsScript)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				status[section] = map[string]any{"status": "unavailable", "reason": err.Error()}
				return
			}
			data, err := hardwareJSON(b)
			if err != nil {
				status[section] = map[string]any{"status": "unavailable", "reason": "Invalid provider JSON"}
				return
			}
			state := "collected"
			if issues, ok := data["issues"].([]any); ok && len(issues) > 0 {
				state = "partial"
			}
			status[section] = map[string]any{"status": state, "issues": data["issues"]}
			for k, v := range data {
				if k != "issues" {
					h[k] = v
				}
			}
		}(section)
	}
	wg.Wait()
	if slots, err := windowsMemorySlots(); err != nil {
		status["smbios"] = map[string]any{"status": "unavailable", "reason": err.Error()}
	} else {
		status["smbios"] = map[string]any{"status": "collected"}
		memory, ok := h["memory"].(map[string]any)
		if !ok {
			memory = map[string]any{}
			h["memory"] = memory
		}
		memory["slot_records"] = slots
		// A disagreement remains explicit rather than silently inventing sockets.
		memory["smbios_slots"] = len(slots)
	}
	h["sources"] = status
	return h
}

func windowsMemorySlots() ([]map[string]any, error) {
	proc := kernel32.NewProc("GetSystemFirmwareTable")
	n, _, err := proc.Call(0x52534d42, 0, 0, 0)
	if n < 8 || n > 4*1024*1024 {
		return nil, fmt.Errorf("SMBIOS size unavailable: %v", err)
	}
	b := make([]byte, int(n))
	got, _, err := proc.Call(0x52534d42, 0, uintptr(unsafe.Pointer(&b[0])), n)
	if got != n {
		return nil, fmt.Errorf("SMBIOS read failed: %v", err)
	}
	length := int(binary.LittleEndian.Uint32(b[4:8]))
	if length > len(b)-8 {
		return nil, fmt.Errorf("invalid SMBIOS length")
	}
	return smbiosMemorySlots(b[8 : 8+length])
}
