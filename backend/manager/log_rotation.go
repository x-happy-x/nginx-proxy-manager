package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const proxyLogBackups = 4

func (a *app) rotateProxyLogs() error {
	maxMB, err := strconv.ParseInt(getenv("PROXY_LOG_MAX_MB", "16"), 10, 64)
	if err != nil || maxMB < 1 || maxMB > 1024 {
		return fmt.Errorf("PROXY_LOG_MAX_MB must be between 1 and 1024")
	}
	paths := []string{a.routeAccessLog, getenv("NGINX_ACCESS_LOG", "/opt/var/log/homenet/access.log"), getenv("NGINX_ERROR_LOG", "/opt/var/log/homenet/error.log")}
	// Do not inspect or signal a process when all logs are below the threshold.
	needed := false
	for _, path := range paths {
		info, err := rotationFile(path)
		if err != nil {
			return err
		}
		if info != nil && info.Size() > maxMB<<20 {
			needed = true
		}
	}
	if !needed {
		return nil
	}
	pid, err := a.proxyLogMasterPID()
	if err != nil {
		return err
	}
	return rotateLogFiles(paths, maxMB<<20, func() error {
		current, err := a.proxyLogMasterPID()
		if err != nil {
			return err
		}
		if current != pid {
			return fmt.Errorf("dedicated nginx master changed during log rotation")
		}
		if runtime.GOOS != "linux" {
			return fmt.Errorf("proxy log reopen is supported only on the Linux router")
		}
		out, err := exec.Command("kill", "-USR1", strconv.Itoa(pid)).CombinedOutput()
		if err != nil {
			return fmt.Errorf("reopen dedicated nginx logs: %w: %s", err, out)
		}
		return nil
	})
}

func (a *app) proxyLogMasterPID() (int, error) {
	conf := getenv("NGINX_MAIN_CONF", filepath.Join(a.nginxConfRoot, "nginx.conf"))
	binary := getenv("NGINX_BINARY", "/usr/sbin/nginx")
	pidFile := getenv("NGINX_PID", filepath.Join(a.nginxConfRoot, "nginx.pid"))
	inside := func(path string) bool {
		rel, err := filepath.Rel(a.nginxConfRoot, path)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	}
	if !filepath.IsAbs(binary) || !filepath.IsAbs(conf) || !filepath.IsAbs(pidFile) || !inside(conf) || !inside(pidFile) {
		return 0, fmt.Errorf("log rotation requires an explicit dedicated nginx config and PID")
	}
	body, err := os.ReadFile(pidFile)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(body)))
	if err != nil || pid < 2 {
		return 0, fmt.Errorf("invalid dedicated nginx PID")
	}
	cmdline, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return 0, err
	}
	line := strings.ReplaceAll(string(cmdline), "\x00", " ")
	if !strings.Contains(line, "nginx: master process") || !strings.Contains(line, binary) || !strings.Contains(line, conf) {
		return 0, fmt.Errorf("refusing to signal a process outside the dedicated proxy")
	}
	return pid, nil
}

// Missing files are fine. Directories, symlinks and non-normalized paths are not
// log files and must never be moved by maintenance.
func rotationFile(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) == "." {
		return nil, fmt.Errorf("unsafe log path %q", path)
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing non-regular log file %s", path)
	}
	return info, nil
}

type logMove struct{ from, to string }
type logRotation struct {
	path, temporary string
	created         os.FileInfo
	moves           []logMove
}

func (r *logRotation) move(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	r.moves = append(r.moves, logMove{from: from, to: to})
	return nil
}
func (r *logRotation) rollback() error {
	if r.created != nil {
		info, err := os.Lstat(r.path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() != 0 || !os.SameFile(info, r.created) {
			return fmt.Errorf("replacement log changed; archived data retained at %s.1 and %s", r.path, r.temporary)
		}
		if err := os.Remove(r.path); err != nil {
			return err
		}
	}
	for i := len(r.moves) - 1; i >= 0; i-- {
		if err := os.Rename(r.moves[i].to, r.moves[i].from); err != nil {
			return err
		}
	}
	return os.Remove(r.temporary)
}

func rotateLogFiles(paths []string, maxBytes int64, reopen func() error) error {
	if maxBytes < 1 || reopen == nil {
		return fmt.Errorf("rotation requires a positive limit and verified reopen callback")
	}
	unique := map[string]bool{}
	candidates := []string{}
	for _, path := range paths {
		for _, other := range paths {
			for i := 1; i <= proxyLogBackups; i++ {
				if other == path+"."+strconv.Itoa(i) {
					return fmt.Errorf("configured log %s overlaps another log's backup", other)
				}
			}
		}
	}
	// Validate every source and backup before touching any file.
	for _, path := range paths {
		if unique[path] {
			continue
		}
		unique[path] = true
		info, err := rotationFile(path)
		if err != nil {
			return err
		}
		if info == nil || info.Size() <= maxBytes {
			continue
		}
		for i := 1; i <= proxyLogBackups; i++ {
			if _, err := rotationFile(path + "." + strconv.Itoa(i)); err != nil {
				return err
			}
		}
		candidates = append(candidates, path)
	}
	if len(candidates) == 0 {
		return nil
	}
	rotations := []*logRotation{}
	rollback := func(cause error) error {
		errs := []error{cause}
		for i := len(rotations) - 1; i >= 0; i-- {
			if err := rotations[i].rollback(); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	}
	for _, path := range candidates {
		original, err := rotationFile(path)
		if err != nil {
			return rollback(err)
		}
		if original == nil {
			return rollback(fmt.Errorf("log disappeared during rotation"))
		}
		temporary, err := os.MkdirTemp(filepath.Dir(path), ".homenet-log-rotation-")
		if err != nil {
			return rollback(err)
		}
		r := &logRotation{path: path, temporary: temporary}
		rotations = append(rotations, r)
		last := path + "." + strconv.Itoa(proxyLogBackups)
		if info, _ := rotationFile(last); info != nil {
			if err := r.move(last, filepath.Join(temporary, "oldest.log")); err != nil {
				return rollback(err)
			}
		}
		for i := proxyLogBackups - 1; i >= 1; i-- {
			old := path + "." + strconv.Itoa(i)
			if info, _ := rotationFile(old); info != nil {
				if err := r.move(old, path+"."+strconv.Itoa(i+1)); err != nil {
					return rollback(err)
				}
			}
		}
		if err := r.move(path, path+".1"); err != nil {
			return rollback(err)
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, original.Mode().Perm())
		if err != nil {
			return rollback(err)
		}
		r.created, err = f.Stat()
		closeErr := f.Close()
		if err != nil {
			return rollback(err)
		}
		if closeErr != nil {
			return rollback(closeErr)
		}
	}
	if err := reopen(); err != nil {
		return rollback(err)
	}
	// USR1 never interrupts requests. Old descriptors remain valid until nginx
	// has opened the replacements; telemetry can drain the plain .1 backup.
	errs := []error{}
	for _, r := range rotations {
		oldest := filepath.Join(r.temporary, "oldest.log")
		if err := os.Remove(oldest); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err)
			continue
		}
		if err := os.Remove(r.temporary); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
