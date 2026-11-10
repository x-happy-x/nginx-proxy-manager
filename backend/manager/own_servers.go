package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"gopkg.in/yaml.v3"
)

var ownServersMu sync.Mutex

func ownServersPath() string {
	return filepath.Join(filepath.Dir(coreConfigPath()), "own-servers.yaml")
}
func ownServersRoot() (*yaml.Node, *yaml.Node, error) {
	raw, err := os.ReadFile(ownServersPath())
	if err != nil {
		return nil, nil, err
	}
	return yamlRoot(raw)
}
func readOwnOLCServers() ([]*olcServer, bool, error) {
	ownServersMu.Lock()
	defer ownServersMu.Unlock()
	_, root, err := ownServersRoot()
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, fmt.Errorf("не удалось прочитать own-servers.yaml")
	}
	n := mapGet(root, "olcrtc-servers")
	if n == nil {
		return nil, false, nil
	}
	var data []map[string]any
	if err = n.Decode(&data); err != nil {
		return nil, true, fmt.Errorf("неверный список olcrtc-servers")
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, true, err
	}
	var servers []*olcServer
	if err = json.Unmarshal(raw, &servers); err != nil {
		return nil, true, fmt.Errorf("неверные профили OLC")
	}
	return servers, true, nil
}
func writeOwnOLCServers(servers []*olcServer) (bool, error) {
	ownServersMu.Lock()
	defer ownServersMu.Unlock()
	doc, root, err := ownServersRoot()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("не удалось прочитать own-servers.yaml")
	}
	// Migration explicitly enables profile storage with this field.
	if mapGet(root, "olcrtc-servers") == nil {
		return false, nil
	}
	raw, err := json.Marshal(servers)
	if err != nil {
		return true, err
	}
	var parsed yaml.Node
	if err = yaml.Unmarshal(raw, &parsed); err != nil {
		return true, err
	}
	yamlSet(root, "olcrtc-servers", parsed.Content[0])
	body, err := yaml.Marshal(doc)
	if err != nil {
		return true, err
	}
	file, err := os.CreateTemp(filepath.Dir(ownServersPath()), ".own-servers-*")
	if err != nil {
		return true, err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(body); err != nil {
		file.Close()
		return true, err
	}
	if err = file.Close(); err != nil {
		return true, err
	}
	return true, os.Rename(file.Name(), ownServersPath())
}
