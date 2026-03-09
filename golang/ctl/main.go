package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/amagomedsharipov/nginx-proxy-manager/golang/internal/envfile"
)

type cli struct {
	scriptDir     string
	srcDir        string
	dstDir        string
	uiLog         string
	uiPID         string
	routesPath    string
	genRoutesPath string
	nginxConfRoot string
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	rootDir := filepath.Dir(exe)
	if wd, err := os.Getwd(); err == nil && fileExists(filepath.Join(wd, "init.d")) {
		rootDir = wd
	} else if resolved, ok := findProjectRoot(rootDir); ok {
		rootDir = resolved
	}
	loadRuntimeEnv(rootDir)
	c := &cli{
		scriptDir:     rootDir,
		srcDir:        filepath.Join(rootDir, "init.d"),
		dstDir:        getenv("HOME_NET_INITD_DIR", "/opt/etc/init.d"),
		uiLog:         getenv("HOME_NET_UI_LOG", "/opt/var/log/nginx-manager-lite.log"),
		uiPID:         getenv("HOME_NET_UI_PID", "/opt/var/run/nginx-manager-lite.pid"),
		routesPath:    getenv("ROUTES_PATH", filepath.Join(rootDir, "routes.yml")),
		genRoutesPath: getenv("GEN_ROUTES_PATH", filepath.Join(rootDir, "bin", runtime.GOOS+"-"+runtime.GOARCH, "nginx")),
		nginxConfRoot: getenv("NGINX_CONF_ROOT", "/opt/etc/nginx"),
	}

	if len(os.Args) < 2 {
		c.usage(os.Stdout)
		return
	}

	switch os.Args[1] {
	case "setup":
		must(c.linkScripts())
		must(c.runActionInOrder("restart"))
	case "links":
		must(c.linkScripts())
	case "start":
		must(c.runActionInOrder("start"))
	case "stop":
		must(c.runActionReverse("stop"))
	case "restart":
		must(c.runActionInOrder("restart"))
	case "apply":
		must(c.apply(os.Args[2:]))
	case "status":
		must(c.status(os.Stdout))
	case "logs":
		lines := 80
		if len(os.Args) > 2 {
			lines = atoiDefault(os.Args[2], 80)
		}
		must(c.logs(os.Stdout, lines))
	case "help", "-h", "--help":
		c.usage(os.Stdout)
	default:
		c.usage(os.Stderr)
		os.Exit(1)
	}
}

func loadRuntimeEnv(rootDir string) {
	path := getenv("CONFIG_ENV_PATH", filepath.Join(rootDir, "config", "runtime.env"))
	_ = envfile.Load(path)
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func (c *cli) usage(w io.Writer) {
	fmt.Fprintln(w, "Usage: homenet <command>")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	fmt.Fprintln(w, "  setup      Link managed init.d scripts and restart them in order")
	fmt.Fprintln(w, "  links      Link managed init.d scripts only")
	fmt.Fprintln(w, "  start      Start managed scripts in order")
	fmt.Fprintln(w, "  stop       Stop managed scripts in reverse order")
	fmt.Fprintln(w, "  restart    Restart managed scripts in order")
	fmt.Fprintln(w, "  apply      Apply routes via generator")
	fmt.Fprintln(w, "  status     Show symlink and runtime status")
	fmt.Fprintln(w, "  logs [N]   Tail UI log (default: 80 lines)")
	fmt.Fprintln(w, "  help       Show this help")
}

func (c *cli) listManaged() ([]string, error) {
	entries, err := os.ReadDir(c.srcDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	items := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, "S") {
			items = append(items, name)
		}
	}
	sort.Strings(items)
	return items, nil
}

func (c *cli) linkScripts() error {
	items, err := c.listManaged()
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return fmt.Errorf("no managed scripts in %s (expected S*)", c.srcDir)
	}
	if err := os.MkdirAll(c.dstDir, 0o755); err != nil {
		return err
	}
	for _, name := range items {
		src := filepath.Join(c.srcDir, name)
		dst := filepath.Join(c.dstDir, name)
		_ = os.Remove(dst)
		if err := os.Symlink(src, dst); err != nil {
			return err
		}
		if err := os.Chmod(src, 0o755); err != nil {
			return err
		}
		fmt.Printf("linked: %s -> %s\n", dst, src)
	}
	return nil
}

func (c *cli) runActionInOrder(action string) error {
	items, err := c.listManaged()
	if err != nil {
		return err
	}
	for _, name := range items {
		script := filepath.Join(c.dstDir, name)
		if !isExecutable(script) {
			continue
		}
		fmt.Printf("%s: %s\n", action, script)
		if err := exec.Command(script, action).Run(); err != nil {
			// match shell script behavior: keep going
			continue
		}
	}
	return nil
}

func (c *cli) runActionReverse(action string) error {
	items, err := c.listManaged()
	if err != nil {
		return err
	}
	for i := len(items) - 1; i >= 0; i-- {
		script := filepath.Join(c.dstDir, items[i])
		if !isExecutable(script) {
			continue
		}
		fmt.Printf("%s: %s\n", action, script)
		if err := exec.Command(script, action).Run(); err != nil {
			continue
		}
	}
	return nil
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular() && info.Mode()&0o111 != 0
}

func (c *cli) status(w io.Writer) error {
	items, err := c.listManaged()
	if err != nil {
		return err
	}
	for _, name := range items {
		src := filepath.Join(c.srcDir, name)
		dst := filepath.Join(c.dstDir, name)
		linkState := "missing"
		if target, err := os.Readlink(dst); err == nil {
			linkState = "linked -> " + target
		} else if _, err := os.Stat(dst); err == nil {
			linkState = "exists (not symlink)"
		}
		runState := "unknown"
		if name == "S99nginx-manager-lite" {
			runState = "stopped"
			if pid, ok := c.readRunningPID(); ok {
				runState = fmt.Sprintf("running (pid %d)", pid)
			}
		}
		fmt.Fprintf(w, "%s: %s; state: %s\n", name, linkState, runState)
		if !fileExists(src) {
			fmt.Fprintf(w, "  warning: source missing: %s\n", src)
		}
	}
	return nil
}

func (c *cli) readRunningPID() (int, bool) {
	body, err := os.ReadFile(c.uiPID)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(body)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	proc := filepath.Join("/proc", strconv.Itoa(pid))
	if !fileExists(proc) {
		return 0, false
	}
	return pid, true
}

func (c *cli) logs(w io.Writer, lines int) error {
	file, err := os.Open(c.uiLog)
	if err != nil {
		return fmt.Errorf("missing log: %s", c.uiLog)
	}
	defer file.Close()
	all := []string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		all = append(all, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	for _, line := range all {
		fmt.Fprintln(w, line)
	}
	return nil
}

func (c *cli) apply(args []string) error {
	if !fileExists(c.genRoutesPath) {
		return fmt.Errorf("missing generator: %s", c.genRoutesPath)
	}
	if !fileExists(c.routesPath) {
		return fmt.Errorf("missing routes file: %s", c.routesPath)
	}
	fmt.Printf("apply: %s --config %s\n", c.genRoutesPath, c.routesPath)
	cmdArgs := append([]string{c.genRoutesPath, "--config", c.routesPath}, args...)
	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "NGINX_CONF_ROOT="+c.nginxConfRoot)
	return cmd.Run()
}

func atoiDefault(value string, fallback int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		return n
	}
	return fallback
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func findProjectRoot(start string) (string, bool) {
	dir := start
	for {
		if fileExists(filepath.Join(dir, "init.d")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}
