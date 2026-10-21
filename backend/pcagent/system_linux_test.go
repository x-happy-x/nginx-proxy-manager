package main

import "testing"

func TestLinuxCounters(t *testing.T) {
	total, idle, err := cpuCounters("cpu  100 20 30 400 50 1 2 3 90 10\ncpu0 1 2 3")
	if err != nil || total != 606 || idle != 450 {
		t.Fatal(total, idle, err)
	}
	if _, _, err := cpuCounters(""); err == nil {
		t.Fatal("accepted missing CPU counters")
	}
	m := parseMemory("MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 100 kB\n")
	if m.Total != 1024000 || m.Used != 614400 || m.Available != 409600 {
		t.Fatal(m)
	}
}

func TestDefaultRouteInterfacesExcludeDockerBridgesAndUnreachable(t *testing.T) {
	routes := "Iface Destination Gateway Flags\neth0 00000000 0100000A 0003\ndocker0 000011AC 00000000 0001\nlo 00000000 00000000 0201\n"
	ipv6 := "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000064 00000000 00000000 00000003 eth1\n"
	uplinks := defaultRouteInterfaces(routes, ipv6)
	if len(uplinks) != 2 || !uplinks["eth0"] || !uplinks["eth1"] {
		t.Fatal(uplinks)
	}
}
