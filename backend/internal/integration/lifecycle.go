package integration

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Runtime controls only integration workers. nginx, mihomo and installed apps are
// deliberately outside this interface, so disabling a module cannot stop them.
type Runtime interface {
	Start(context.Context, Manifest) error
	Stop(context.Context, Manifest) error
	Check(context.Context, Manifest) error
}
type Change struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	Version string `json:"version,omitempty"`
}
type Operation struct {
	ID       string            `json:"id"`
	Status   string            `json:"status"`
	Step     string            `json:"step"`
	Created  time.Time         `json:"created"`
	Before   []Installed       `json:"before"`
	After    []Installed       `json:"after"`
	Changes  []Change          `json:"changes"`
	Error    string            `json:"error,omitempty"`
	Packages map[string]string `json:"packages"`
}
type Lifecycle struct {
	Registry    *Registry
	Runtime     Runtime
	PackagesDir string
	StateDir    string
	Arch        string
	mu          sync.Mutex
}

func (l *Lifecycle) Stable(fn func()) { l.mu.Lock(); defer l.mu.Unlock(); fn() }

func (l *Lifecycle) Ready() error {
	if err := l.transactionsPending(); err != nil {
		return err
	}
	ops, err := l.History()
	if err != nil {
		return err
	}
	for _, op := range ops {
		if op.Status == "running" || op.Status == "recovering" || op.Status == "recovery_required" {
			return fmt.Errorf("unfinished operation %s", op.ID)
		}
	}
	return nil
}

func (l *Lifecycle) transactionsPending() error {
	files, err := os.ReadDir(filepath.Join(l.StateDir, "transactions"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(l.StateDir, "transactions", file.Name()))
		if err != nil {
			return err
		}
		var item struct{ Status string }
		if err = json.Unmarshal(b, &item); err != nil {
			return err
		}
		if item.Status != "committed" && item.Status != "rolled_back" {
			return fmt.Errorf("pending configuration transaction %s must finish before switching workers", file.Name())
		}
	}
	return nil
}

func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func AtomicJSON(file string, v any) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), file); err != nil {
		return err
	}
	// Directory fsync makes the rename durable across power loss on Linux.
	if dir, e := os.Open(filepath.Dir(file)); e == nil {
		defer dir.Close()
		_ = dir.Sync()
	}
	return nil
}
func (l *Lifecycle) save(op Operation) error {
	return AtomicJSON(filepath.Join(l.StateDir, "operations", op.ID+".json"), op)
}
func (l *Lifecycle) Operation(id string) (Operation, error) {
	var op Operation
	if !ValidID(id) {
		return op, fmt.Errorf("invalid operation ID")
	}
	b, err := os.ReadFile(filepath.Join(l.StateDir, "operations", id+".json"))
	if err != nil {
		return op, err
	}
	err = json.Unmarshal(b, &op)
	return op, err
}
func (l *Lifecycle) History() ([]Operation, error) {
	entries, err := os.ReadDir(filepath.Join(l.StateDir, "operations"))
	if os.IsNotExist(err) {
		return []Operation{}, nil
	}
	if err != nil {
		return nil, err
	}
	ops := []Operation{}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		op, err := l.Operation(e.Name()[:len(e.Name())-5])
		if err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].Created.After(ops[j].Created) })
	return ops, nil
}
func (l *Lifecycle) Candidate(id, v string) (Manifest, error) {
	var m Manifest
	if !ValidID(id) || !version.MatchString(v) {
		return m, fmt.Errorf("invalid package identity")
	}
	root := filepath.Join(l.PackagesDir, id, v)
	base, err := filepath.EvalSymlinks(l.PackagesDir)
	if err != nil {
		return m, err
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return m, err
	}
	if !samePath(resolved, filepath.Join(base, id, v)) {
		return m, fmt.Errorf("package directory cannot traverse symlinks")
	}
	b, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.ID != id || m.Version != v {
		return m, fmt.Errorf("package identity mismatch")
	}
	if err = m.Validate(l.Arch); err != nil {
		return m, err
	}
	artifacts := []string{"manifest.json", "worker", filepath.Join("ui", m.UI.Entry)}
	if m.ID == "proxy" {
		artifacts = append(artifacts, "nginx")
	}
	for _, name := range append(artifacts, cssFiles(m.UI.CSS)...) {
		p := filepath.Join(root, name)
		info, err := os.Lstat(p)
		if err != nil || !info.Mode().IsRegular() {
			return m, fmt.Errorf("missing or unsafe package artifact %s", name)
		}
		actual, err := filepath.EvalSymlinks(p)
		if err != nil || !samePath(actual, filepath.Join(resolved, name)) {
			return m, fmt.Errorf("package artifacts cannot traverse symlinks")
		}
	}
	return m, nil
}
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}
func cssFiles(paths []string) []string {
	out := []string{}
	for _, p := range paths {
		out = append(out, filepath.Join("ui", p))
	}
	return out
}
func (l *Lifecycle) Available() ([]Manifest, error) {
	out := []Manifest{}
	ids, err := os.ReadDir(l.PackagesDir)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if !id.IsDir() || !ValidID(id.Name()) {
			continue
		}
		versions, err := os.ReadDir(filepath.Join(l.PackagesDir, id.Name()))
		if err != nil {
			return nil, err
		}
		for _, v := range versions {
			if !v.IsDir() || !version.MatchString(v.Name()) {
				continue
			}
			m, err := l.Candidate(id.Name(), v.Name())
			if err != nil {
				return nil, fmt.Errorf("%s/%s: %w", id.Name(), v.Name(), err)
			}
			out = append(out, m)
		}
	}
	return out, nil
}
func (l *Lifecycle) Plan(changes []Change) (Operation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	op := Operation{Status: "planned", Step: "validated", Created: time.Now().UTC(), Before: l.Registry.Snapshot(), Changes: changes}
	if len(changes) == 0 || len(changes) > 32 {
		return op, fmt.Errorf("select 1..32 changes")
	}
	op.After = clone(op.Before)
	seen := map[string]bool{}
	for _, c := range changes {
		if !ValidID(c.ID) || seen[c.ID] {
			return op, fmt.Errorf("invalid or repeated integration")
		}
		seen[c.ID] = true
		index := -1
		for i, v := range op.After {
			if v.Manifest.ID == c.ID {
				index = i
				break
			}
		}
		switch c.Action {
		case "install", "update", "rollback":
			m, err := l.Candidate(c.ID, c.Version)
			if err != nil {
				return op, err
			}
			if c.Action == "install" && index >= 0 {
				return op, fmt.Errorf("already installed")
			}
			if c.Action != "install" && index < 0 {
				return op, fmt.Errorf("not installed")
			}
			if index < 0 {
				op.After = append(op.After, Installed{Manifest: m, Enabled: true, Connection: "unconfigured"})
			} else {
				old := op.After[index].Manifest
				if m.DataSchema != old.DataSchema || digest(m.DataDirectories) != digest(old.DataDirectories) {
					return op, fmt.Errorf("data layout/schema change requires an explicit migration package")
				}
				op.After[index].Manifest = m
			}
		case "enable", "disable", "remove":
			if index < 0 {
				return op, fmt.Errorf("not installed")
			}
			if c.Action == "remove" {
				op.After = append(op.After[:index], op.After[index+1:]...)
			} else {
				op.After[index].Enabled = c.Action == "enable"
			}
		default:
			return op, fmt.Errorf("unsupported lifecycle action")
		}
	}
	sort.Slice(op.After, func(i, j int) bool { return op.After[i].Manifest.ID < op.After[j].Manifest.ID })
	if err := l.Registry.validate(op.After); err != nil {
		return op, err
	}
	op.Packages = map[string]string{}
	for _, item := range append(clone(op.Before), op.After...) {
		key := item.Manifest.ID + "/" + item.Manifest.Version
		hash, err := l.packageHash(item.Manifest)
		if err != nil {
			return op, err
		}
		op.Packages[key] = hash
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return op, err
	}
	op.ID = "op-" + hex.EncodeToString(b)
	return op, l.save(op)
}

func (l *Lifecycle) packageHash(m Manifest) (string, error) {
	root := filepath.Join(l.PackagesDir, m.ID, m.Version)
	h := sha256.New()
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("unsafe package artifact")
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%d:%s:%d:", len(rel), rel, info.Size())
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(h, f)
		return err
	})
	return hex.EncodeToString(h.Sum(nil)), err
}

// Dependencies start before their consumers and stop after them.
func ordered(items []Installed, reverse bool) []Installed {
	byID := map[string]Installed{}
	for _, i := range items {
		byID[i.Manifest.ID] = i
	}
	done := map[string]bool{}
	result := []Installed{}
	var visit func(Installed)
	visit = func(i Installed) {
		if done[i.Manifest.ID] {
			return
		}
		done[i.Manifest.ID] = true
		for _, d := range i.Manifest.Dependencies {
			if dep, ok := byID[d.ID]; ok {
				visit(dep)
			}
		}
		result = append(result, i)
	}
	for _, i := range items {
		visit(i)
	}
	if reverse {
		for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
			result[i], result[j] = result[j], result[i]
		}
	}
	return result
}
func changed(items, other []Installed) []Installed {
	out := []Installed{}
	for _, i := range items {
		same := false
		for _, j := range other {
			if digest(i) == digest(j) {
				same = true
				break
			}
		}
		if !same {
			out = append(out, i)
		}
	}
	return out
}
func (l *Lifecycle) Apply(ctx context.Context, id string) (result Operation, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	defer func() {
		if err != nil && result.ID != "" && result.Status == "planned" {
			result.Status = "rejected"
			result.Error = err.Error()
			err = errors.Join(err, l.save(result))
		}
	}()
	op, err := l.Operation(id)
	if err != nil {
		return op, err
	}
	if op.Status != "planned" {
		return op, nil
	} // replay has no side effects
	if err := ctx.Err(); err != nil {
		return op, err
	}
	if err := l.transactionsPending(); err != nil {
		return op, err
	}
	operations, err := l.History()
	if err != nil {
		return op, err
	}
	for _, other := range operations {
		if other.ID != op.ID && (other.Status == "running" || other.Status == "recovering" || other.Status == "recovery_required") {
			return op, fmt.Errorf("operation %s requires recovery", other.ID)
		}
	}
	if digest(l.Registry.Snapshot()) != digest(op.Before) {
		return op, fmt.Errorf("plan expired: registry changed")
	}
	for _, i := range op.After {
		m, err := l.Candidate(i.Manifest.ID, i.Manifest.Version)
		if err != nil || digest(m) != digest(i.Manifest) {
			return op, fmt.Errorf("package changed since planning")
		}
	}
	for _, i := range append(clone(op.Before), op.After...) {
		hash, err := l.packageHash(i.Manifest)
		if err != nil || hash != op.Packages[i.Manifest.ID+"/"+i.Manifest.Version] {
			return op, fmt.Errorf("package artifacts changed since planning")
		}
	}
	op.Status = "running"
	op.Step = "stopping"
	if err = l.save(op); err != nil {
		return op, err
	}
	fail := func(cause error) (Operation, error) {
		op.Error = cause.Error()
		recovery, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		err := l.rollback(recovery, &op)
		return op, errors.Join(cause, err)
	}
	for _, i := range ordered(changed(op.Before, op.After), true) {
		if i.Enabled {
			if err = l.Runtime.Stop(ctx, i.Manifest); err != nil {
				return fail(err)
			}
		}
	}
	op.Step = "starting"
	if err = l.save(op); err != nil {
		return fail(err)
	}
	for _, i := range ordered(changed(op.After, op.Before), false) {
		if i.Enabled {
			if err = l.Runtime.Start(ctx, i.Manifest); err != nil {
				return fail(err)
			}
			if err = l.Runtime.Check(ctx, i.Manifest); err != nil {
				return fail(err)
			}
		}
	}
	op.Step = "committing"
	if err = l.save(op); err != nil {
		return fail(err)
	}
	if err = l.Registry.Replace(op.After); err != nil {
		return fail(err)
	}
	op.Status = "succeeded"
	op.Step = "complete"
	err = l.save(op)
	return op, err
}
func (l *Lifecycle) rollback(ctx context.Context, op *Operation) error {
	op.Status = "recovering"
	op.Step = "rollback"
	if err := l.save(*op); err != nil {
		return err
	}
	var errs []error
	for _, i := range op.Before {
		hash, err := l.packageHash(i.Manifest)
		if err != nil || hash != op.Packages[i.Manifest.ID+"/"+i.Manifest.Version] {
			errs = append(errs, fmt.Errorf("previous package changed; restore trusted artifacts before recovery: %s", i.Manifest.ID))
		}
	}
	for _, i := range ordered(changed(op.After, op.Before), true) {
		if i.Enabled {
			if err := l.Runtime.Stop(ctx, i.Manifest); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if len(errs) == 0 {
		for _, i := range ordered(changed(op.Before, op.After), false) {
			if i.Enabled {
				if err := l.Runtime.Start(ctx, i.Manifest); err != nil {
					errs = append(errs, err)
				} else if err = l.Runtime.Check(ctx, i.Manifest); err != nil {
					errs = append(errs, err)
				}
			}
		}
	}
	if len(errs) == 0 {
		if err := l.Registry.Replace(op.Before); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		op.Status = "recovery_required"
		op.Error += "; " + errors.Join(errs...).Error()
	} else {
		op.Status = "rolled_back"
		op.Step = "complete"
	}
	if err := l.save(*op); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Recover is called before serving management requests. Ambiguous interrupted
// activation always restores the previous set; it never guesses that it succeeded.
func (l *Lifecycle) Recover(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	ops, err := l.History()
	if err != nil {
		return err
	}
	for _, op := range ops {
		if op.Status == "running" || op.Status == "recovering" || op.Status == "recovery_required" {
			if err := l.rollback(ctx, &op); err != nil {
				return err
			}
		}
	}
	return nil
}
