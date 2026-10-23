package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// An extensible document: unknown categories and source fields are not discarded.
// It is optional in v1 snapshots, so old agents and consumers remain compatible.
func collectHardware(ctx context.Context, run runner) map[string]any {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	h := platformHardware(ctx, run)
	h["v"], h["ts"], h["agent"] = 1, time.Now().Unix(), version
	h["host"], _ = os.Hostname()
	return h
}

// SMBIOS type 17 includes empty sockets that Win32_PhysicalMemory omits.
// Preserve firmware locator/bank labels; do not infer motherboard A1/A2 labels.
func smbiosMemorySlots(table []byte) ([]map[string]any, error) {
	slots := []map[string]any{}
	for pos := 0; pos+4 <= len(table); {
		kind, length := table[pos], int(table[pos+1])
		if length < 4 || pos+length > len(table) {
			return slots, fmt.Errorf("truncated SMBIOS structure")
		}
		start := pos + length
		end := bytes.Index(table[start:], []byte{0, 0})
		if end < 0 {
			return slots, fmt.Errorf("unterminated SMBIOS strings")
		}
		text := strings.Split(string(table[start:start+end]), "\x00")
		str := func(index byte) string {
			if index == 0 || int(index) > len(text) {
				return ""
			}
			return strings.TrimSpace(strings.ToValidUTF8(text[index-1], "�"))
		}
		if kind == 17 && length >= 0x15 {
			size := binary.LittleEndian.Uint16(table[pos+0x0c:])
			state := "unknown"
			var capacity uint64
			if size == 0 {
				state = "empty"
			} else if size != 0xffff {
				if size == 0x7fff && length >= 0x20 {
					capacity = uint64(binary.LittleEndian.Uint32(table[pos+0x1c:])&0x7fffffff) * 1024 * 1024
				} else if size != 0x7fff {
					capacity = uint64(size&0x7fff) * 1024
					if size&0x8000 == 0 {
						capacity *= 1024
					}
				}
				if capacity > 0 {
					state = "populated"
				}
			}
			slots = append(slots, map[string]any{"id": fmt.Sprintf("smbios:%04x", binary.LittleEndian.Uint16(table[pos+2:])), "slot": str(table[pos+0x10]), "bank": str(table[pos+0x11]), "state": state, "size_bytes": capacity, "source": "SMBIOS type 17"})
		}
		pos = start + end + 2
		if kind == 127 {
			break
		}
	}
	return slots, nil
}

func hardwareJSON(b []byte) (map[string]any, error) {
	var h map[string]any
	err := json.Unmarshal([]byte(decodeOutput(b)), &h)
	if h == nil && err == nil {
		h = map[string]any{}
	}
	return h, err
}
