package integration

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Processes struct {
	StateDir, PackagesDir, ConfigEnv, AppDir, CoreURL string
	Defaults                                          map[string]string
	mu                                                sync.Mutex
}
type processRecord struct {
	PID        int    `json:"pid"`
	Version    string `json:"version"`
	Executable string `json:"executable"`
	StartTime  string `json:"start_time"`
}

var errOtherVersion = errors.New("another worker version is running")

func processStartTime(pid int) (string, error) {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	end := strings.LastIndexByte(string(b), ')')
	if end < 0 {
		return "", fmt.Errorf("invalid process identity")
	}
	fields := strings.Fields(string(b[end+1:]))
	if len(fields) < 20 {
		return "", fmt.Errorf("invalid process identity")
	}
	return fields[19], nil
}

func (p *Processes) recordPath(id string) string {
	return filepath.Join(p.StateDir, "processes", id+".json")
}
func (p *Processes) tokenFile(id string) string {
	return filepath.Join(p.StateDir, "credentials", id+".token")
}
func (p *Processes) Token(id string) (string, error) {
	if !ValidID(id) {
		return "", fmt.Errorf("invalid integration")
	}
	b, err := os.ReadFile(p.tokenFile(id))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 32 {
		return "", fmt.Errorf("invalid integration credential")
	}
	return token, nil
}
func (p *Processes) ensureToken(id string) error {
	if _, err := p.Token(id); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.tokenFile(id)), 0700); err != nil {
		return err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	f, err := os.OpenFile(p.tokenFile(id), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(hex.EncodeToString(b))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func (p *Processes) record(m Manifest) (processRecord, bool, error) {
	var record processRecord
	b, err := os.ReadFile(p.recordPath(m.ID))
	if os.IsNotExist(err) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	if json.Unmarshal(b, &record) != nil || record.PID < 1 {
		return record, false, fmt.Errorf("invalid worker process record")
	}
	if runtime.GOOS != "linux" {
		return record, false, fmt.Errorf("managed workers require Linux")
	}
	actual, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(record.PID), "exe"))
	if os.IsNotExist(err) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	if actual != record.Executable {
		return record, false, nil
	} // PID reused by an unrelated process
	started, err := processStartTime(record.PID)
	if os.IsNotExist(err) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	if record.StartTime == "" {
		return record, false, fmt.Errorf("worker identity lacks start time")
	}
	if started != record.StartTime {
		return record, false, nil
	}
	if record.Version != m.Version {
		return record, false, errOtherVersion
	}
	expected := filepath.Join(p.PackagesDir, m.ID, m.Version, "worker")
	if expected != record.Executable {
		return record, false, fmt.Errorf("worker executable no longer matches installed package")
	}
	return record, true, nil
}
func (p *Processes) Start(ctx context.Context, m Manifest) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("managed workers require Linux")
	}
	if _, running, err := p.record(m); err != nil {
		return err
	} else if running {
		return nil
	}
	if err := p.ensureToken(m.ID); err != nil {
		return err
	}
	root := filepath.Join(p.PackagesDir, m.ID, m.Version)
	if err := os.MkdirAll(filepath.Join(p.StateDir, "logs"), 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(p.StateDir, "logs", m.ID+".log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(filepath.Join(root, "worker"), "-manifest", filepath.Join(root, "manifest.json"), "-token-file", p.tokenFile(m.ID))
	cmd.Dir = root
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Env = os.Environ()
	for key, value := range p.Defaults {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	if p.ConfigEnv != "" {
		cmd.Env = append(cmd.Env, "CONFIG_ENV_PATH="+p.ConfigEnv)
	}
	cmd.Env = append(cmd.Env, "HOMENET_PLATFORM_STATE="+p.StateDir)
	cmd.Env = append(cmd.Env, "HOMENET_CORE_URL="+p.CoreURL)
	if p.AppDir != "" {
		cmd.Env = append(cmd.Env, "HOMENET_APP_DIR="+p.AppDir)
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	started, identityErr := processStartTime(cmd.Process.Pid)
	if identityErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return identityErr
	}
	if err = AtomicJSON(p.recordPath(m.ID), processRecord{PID: cmd.Process.Pid, Version: m.Version, Executable: filepath.Join(root, "worker"), StartTime: started}); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
func (p *Processes) Stop(ctx context.Context, m Manifest) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	record, running, err := p.record(m)
	if errors.Is(err, errOtherVersion) {
		return nil
	} // rollback must not stop the previous version
	if err != nil {
		return err
	}
	if !running {
		return nil
	}
	proc, err := os.FindProcess(record.PID)
	if err != nil {
		return err
	}
	if err = proc.Signal(syscall.SIGTERM); err != nil && err != os.ErrProcessDone {
		return err
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	killed := false
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			if killed {
				return fmt.Errorf("worker did not exit after kill")
			}
			// Revalidate identity before escalating; never kill a reused PID.
			if _, alive, e := p.record(m); e != nil {
				return e
			} else if alive {
				if e = proc.Kill(); e != nil && e != os.ErrProcessDone {
					return e
				}
			}
			killed = true
			deadline.Reset(5 * time.Second)
		case <-tick.C:
			if _, alive, e := p.record(m); e != nil {
				return e
			} else if !alive {
				return nil
			}
		}
	}
}
func (p *Processes) Check(ctx context.Context, m Manifest) error {
	token, err := p.Token(m.ID)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for attempt := 0; attempt < 30; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(m.Backend.Endpoint, "/")+m.Backend.Health, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := client.Do(req)
		if err == nil {
			var body struct{ Status, Integration, Version string }
			decodeErr := json.NewDecoder(res.Body).Decode(&body)
			res.Body.Close()
			if res.StatusCode == 200 && decodeErr == nil && body.Status == "ok" && body.Integration == m.ID && body.Version == m.Version {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("%s %s readiness failed", m.ID, m.Version)
}
func (l *Lifecycle) Reconcile(ctx context.Context) error {
	if !l.mu.TryLock() {
		return nil
	}
	defer l.mu.Unlock()
	ops, err := l.History()
	if err != nil {
		return err
	}
	for _, op := range ops {
		if op.Status == "recovery_required" || op.Status == "recovering" || op.Status == "running" {
			return fmt.Errorf("unfinished operation %s requires recovery", op.ID)
		}
	}
	for _, i := range ordered(l.Registry.Snapshot(), false) {
		if i.Enabled {
			if err := l.Runtime.Start(ctx, i.Manifest); err != nil {
				return err
			}
		}
	}
	return nil
}
func (l *Lifecycle) Shutdown(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, i := range ordered(l.Registry.Snapshot(), true) {
		if i.Enabled {
			if err := l.Runtime.Stop(ctx, i.Manifest); err != nil {
				return err
			}
		}
	}
	return nil
}
