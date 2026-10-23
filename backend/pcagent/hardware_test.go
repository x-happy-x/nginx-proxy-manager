package main

import (
	"encoding/binary"
	"testing"
)

func TestSMBIOSSlotsKeepEmptySocketsAndBankLabels(t *testing.T) {
	data := []byte{}
	for i, size := range []uint16{0, 0x7fff, 0xffff} {
		b := make([]byte, 0x20)
		b[0] = 17
		b[1] = byte(len(b))
		b[2] = byte(i)
		binary.LittleEndian.PutUint16(b[0x0c:], size)
		b[0x10], b[0x11] = 1, 2
		binary.LittleEndian.PutUint32(b[0x1c:], 48*1024)
		data = append(data, b...)
		data = append(data, []byte("DIMM 1\x00P0 CHANNEL A\x00\x00")...)
	}
	slots, err := smbiosMemorySlots(data)
	if err != nil || len(slots) != 3 {
		t.Fatal(slots, err)
	}
	if slots[0]["state"] != "empty" || slots[1]["state"] != "populated" || slots[2]["state"] != "unknown" || slots[1]["size_bytes"] != uint64(48*1024*1024*1024) || slots[1]["bank"] != "P0 CHANNEL A" {
		t.Fatal(slots)
	}
	if _, err = smbiosMemorySlots([]byte{17, 255, 0, 0}); err == nil {
		t.Fatal("accepted truncated firmware table")
	}
}
