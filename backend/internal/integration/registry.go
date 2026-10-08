package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

type Installed struct {
	Manifest   Manifest `json:"manifest"`
	Enabled    bool     `json:"enabled"`
	Connection string   `json:"connection"` // unconfigured, connected, or unavailable; never inferred from files
}
type Registry struct {
	mu    sync.RWMutex
	path  string
	arch  string
	items []Installed
}
type registryFile struct {
	Schema int         `json:"schema"`
	Items  []Installed `json:"items"`
}

func Open(file, arch string) (*Registry, error) {
	r := &Registry{path: file, arch: arch, items: []Installed{}}
	f, err := os.Open(file)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var state registryFile
	d := json.NewDecoder(io.LimitReader(f, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(&state); err != nil {
		return nil, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("invalid registry trailing data")
	}
	if state.Schema != Protocol {
		return nil, fmt.Errorf("unsupported registry schema")
	}
	if err := r.validate(state.Items); err != nil {
		return nil, err
	}
	r.items = state.Items
	return r, nil
}
func clone(items []Installed) []Installed {
	body, _ := json.Marshal(items)
	result := []Installed{}
	_ = json.Unmarshal(body, &result)
	return result
}
func (r *Registry) Snapshot() []Installed { r.mu.RLock(); defer r.mu.RUnlock(); return clone(r.items) }
func (r *Registry) validate(items []Installed) error {
	manifests := []Manifest{}
	enabled := map[string]bool{}
	for _, i := range items {
		manifests = append(manifests, i.Manifest)
		enabled[i.Manifest.ID] = i.Enabled
		if i.Connection != "unconfigured" && i.Connection != "connected" && i.Connection != "unavailable" {
			return fmt.Errorf("invalid connection state")
		}
	}
	if err := ValidateSet(manifests, r.arch); err != nil {
		return err
	}
	for _, i := range items {
		if i.Enabled {
			for _, d := range i.Manifest.Dependencies {
				if !d.Optional && !enabled[d.ID] {
					return fmt.Errorf("enabled integration %s requires enabled %s", i.Manifest.ID, d.ID)
				}
			}
		}
	}
	return nil
}

// Replace is reserved for the lifecycle coordinator AFTER process and asset checks.
// Registry is an atomic commit point, not a substitute for a release-set journal.
func (r *Registry) Replace(items []Installed) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	items = clone(items)
	if err := r.validate(items); err != nil {
		return err
	}
	if err := AtomicJSON(r.path, registryFile{Protocol, items}); err != nil {
		return err
	}
	r.items = items
	return nil
}
