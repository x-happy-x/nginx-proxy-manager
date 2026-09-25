package main

import (
	"os"
	"testing"
)

func TestMeshNodesFromController(t *testing.T) {
	body, err := os.ReadFile("testdata/mws-member.json")
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := meshNodesFromJSON(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 {
		t.Fatalf("got %d nodes, want 2: %+v", len(nodes), nodes)
	}
	giga, buddy := nodes[0], nodes[1]
	if giga.IP != "192.168.1.219" || giga.Model != "Giga (KN-1012)" || giga.MemTotal != 524288*1024 || giga.UplinkWiFi {
		t.Errorf("giga: %+v", giga)
	}
	if len(giga.Ports) != 5 || !giga.Ports[0].Link || giga.Ports[0].Speed != 1000 {
		t.Errorf("giga ports: %+v", giga.Ports)
	}
	if buddy.IP != "192.168.1.254" || !buddy.UplinkWiFi || buddy.RSSI == 0 || buddy.TxRate == 0 || buddy.MemTotal != 65536*1024 {
		t.Errorf("buddy: %+v", buddy)
	}
	if giga.UptimeSec == 0 || buddy.UptimeSec == 0 || !giga.UpdateReady || giga.Firmware == "" {
		t.Errorf("uptime/firmware: %+v %+v", giga, buddy)
	}
}
