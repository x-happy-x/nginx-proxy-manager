package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnServersPreserveProxyAndPrivateProfiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_CONFIG", filepath.Join(dir, "config.yaml"))
	raw := []byte("proxies:\n  - name: KZ\n    type: vless\n    server: example.org\n    uuid: keep-secret\nolcrtc-servers: []\n")
	if err := os.WriteFile(ownServersPath(), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	servers := []*olcServer{{ID: "own", Name: "OLC own", Host: "example.org", Key: "private-link-key", UDPKey: "private-udp"}}
	if enabled, err := writeOwnOLCServers(servers); err != nil || !enabled {
		t.Fatal(enabled, err)
	}
	read, enabled, err := readOwnOLCServers()
	if err != nil || !enabled || len(read) != 1 || read[0].Key != servers[0].Key || read[0].UDPKey != servers[0].UDPKey {
		t.Fatal("profiles lost")
	}
	_, root, err := ownServersRoot()
	if err != nil || scalar(mapGet(mapGet(root, "proxies").Content[0], "uuid")) != "keep-secret" {
		t.Fatal("proxy changed")
	}
	st := &olcState{path: filepath.Join(dir, "olcrtc.json"), st: olcStore{Servers: servers}}
	st.saveLocked()
	body, _ := os.ReadFile(st.path)
	var persisted olcStore
	json.Unmarshal(body, &persisted)
	if len(persisted.Servers) != 0 || persisted.OwnServersFallback {
		t.Fatal("profiles duplicated in runtime state")
	}
	os.WriteFile(ownServersPath(), []byte("broken: ["), 0o600)
	st.saveLocked()
	body, _ = os.ReadFile(st.path)
	json.Unmarshal(body, &persisted)
	if !persisted.OwnServersFallback || len(persisted.Servers) != 1 {
		t.Fatal("write failure lost profiles")
	}
}
func TestProxyFileMetadataDoesNotExposeInventorySecrets(t *testing.T) {
	dir := t.TempDir()
	cfg := []byte("proxy-files: [own-servers.yaml]\n")
	raw := []byte("proxies:\n  - name: KZ\n    type: vless\n    server: example.org\n    uuid: proxy-secret\nolcrtc-servers:\n  - id: own\n    key: link-secret\n")
	os.WriteFile(filepath.Join(dir, "own-servers.yaml"), raw, 0o600)
	nodes, err := readNodesMeta(filepath.Join(dir, "config.yaml"), cfg)
	if err != nil || len(nodes) != 1 || nodes["KZ"].Server != "example.org" {
		t.Fatal(nodes, err)
	}
}
