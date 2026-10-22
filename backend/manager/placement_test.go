package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseDockerPorts(t *testing.T) {
	got := parseDockerPorts("0.0.0.0:4161->4161/tcp, [::]:4161->4161/tcp, 4160/tcp, 192.168.99.34:4197->3000/tcp, 127.0.0.1:5001->5001/tcp, 0.0.0.0:8098-8099->8098-8099/tcp, 0.0.0.0:53->53/udp")
	want := []publishedPort{
		{IP: "", Port: 4161, Target: "4161/tcp"},
		{IP: "192.168.99.34", Port: 4197, Target: "3000/tcp"},
		{IP: "127.0.0.1", Port: 5001, Target: "5001/tcp"},
		{IP: "", Port: 8098, Target: "8098/tcp"},
		{IP: "", Port: 8099, Target: "8099/tcp"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if got := parseDockerPorts(""); len(got) != 0 {
		t.Fatalf("empty ports: %+v", got)
	}
}

func TestReadARP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "arp")
	_ = os.WriteFile(path, []byte("IP address       HW type     Flags       HW address            Mask     Device\n"+
		"192.168.99.33    0x1         0x2         bc:24:11:20:6b:cb     *        br2\n"+
		"192.168.99.50    0x1         0x0         00:00:00:00:00:00     *        br2\n"), 0o600)
	t.Setenv("PLACEMENT_ARP", path)
	if got := readARP(); !reflect.DeepEqual(got, map[string]string{"bc:24:11:20:6b:cb": "192.168.99.33"}) {
		t.Fatalf("got %v", got)
	}
}

func TestPVEPlacementUsesAgentIPsThenARP(t *testing.T) {
	var snap pvhSnapshot
	_ = json.Unmarshal([]byte(`{"guests":[
		{"vmid":101,"name":"family-apps","type":"qemu","status":"running","ips":["192.168.99.33"],"macs":["bc:24:11:20:6b:cb"]},
		{"vmid":102,"name":"forgejo-ci","type":"qemu","status":"running","macs":["BC:24:11:8C:7D:A8"]},
		{"vmid":9999,"name":"template","type":"qemu","status":"stopped","template":true}]}`), &snap)
	m := &pvhMonitor{hosts: []*pvhHost{{Config: pvhHostConfig{ID: "s3", Name: "s3", Address: "192.168.99.30"}, Online: true, Parsed: &snap}}}
	out := m.placement(map[string]string{"bc:24:11:8c:7d:a8": "192.168.99.34"})
	machines := out["machines"].([]response)
	if len(machines) != 2 {
		t.Fatalf("templates must be skipped: %+v", machines)
	}
	if ips := machines[0]["ips"].([]string); !reflect.DeepEqual(ips, []string{"192.168.99.33"}) {
		t.Fatalf("agent ips: %v", ips)
	}
	if ips := machines[1]["ips"].([]string); !reflect.DeepEqual(ips, []string{"192.168.99.34"}) {
		t.Fatalf("arp fallback: %v", ips)
	}
	if nodes := out["nodes"].([]response); nodes[0]["ip"] != "192.168.99.30" {
		t.Fatalf("nodes: %+v", nodes)
	}
}

func TestPCPlacementListsPublishedPorts(t *testing.T) {
	var snap pcSnapshot
	_ = json.Unmarshal([]byte(`{"docker":[{"context":"native","available":true,"containers":[
		{"id":"0123456789abcdef","name":"homeapps-account-1","image":"account","state":"running","status":"Up 2 days","ports":"0.0.0.0:4161->4161/tcp, [::]:4161->4161/tcp"}]}]}`), &snap)
	m := &pcMonitor{hosts: []*pcHost{{Config: pcHostConfig{ID: "family-apps", Name: "family-apps", Address: "192.168.99.33"}, Online: true, Current: &snap}}}
	containers := m.placement()["containers"].([]response)
	if len(containers) != 1 || containers[0]["id"] != "0123456789ab" || containers[0]["ip"] != "192.168.99.33" {
		t.Fatalf("got %+v", containers)
	}
	if ports := containers[0]["ports"].([]publishedPort); !reflect.DeepEqual(ports, []publishedPort{{Port: 4161, Target: "4161/tcp"}}) {
		t.Fatalf("ports %+v", ports)
	}
}
