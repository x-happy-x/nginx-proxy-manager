package main

import "testing"

func TestPCIUnknownNamesKeepIdentifiersAndDrivers(t *testing.T) {
	devices := parsePCIDevices("Slot:\t0000:01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tDevice [2c02]\nDriver:\tnvidia\n\nSlot:\t0000:02:00.0\nClass:\tEthernet controller [0200]\nVendor:\tRealtek [10ec]\nDevice:\tRTL8125 [8125]\n")
	if len(devices) != 2 || devices[0]["status"] != "unrecognized" || devices[0]["device_id"] != "2c02" || devices[0]["driver"] != "nvidia" || devices[1]["name"] != "RTL8125" {
		t.Fatal(devices)
	}
}

func TestDIMMEmptySlotsAndInstalledBytes(t *testing.T) {
	modules, slots := parseDIMMs("Handle 0x1, DMI type 17, 92 bytes\nMemory Device\n\tSize: 48 GB\n\tLocator: DIMM A2\n\tType: DDR5\n\tConfigured Memory Speed: 4800 MT/s\nHandle 0x2, DMI type 17, 92 bytes\nMemory Device\n\tSize: No Module Installed\n\tLocator: DIMM B2\n")
	if len(modules) != 1 || slots != 2 || modules[0]["size_bytes"] != uint64(48*1024*1024*1024) || modules[0]["slot"] != "DIMM A2" {
		t.Fatal(modules, slots)
	}
}
