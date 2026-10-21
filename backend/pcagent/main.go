// pc-agent is a one-shot, SSH forced-command agent for Windows and Linux PCs.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

const version = "1.0.0"

type CPU struct {
	Percent *float64 `json:"percent"`
	Cores   int      `json:"cores"`
	Model   string   `json:"model"`
}
type Memory struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
}
type Disk struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}
type Network struct {
	Name      string `json:"name"`
	RX        uint64 `json:"rx_bytes"`
	TX        uint64 `json:"tx_bytes"`
	Aggregate bool   `json:"aggregate"`
}
type Distribution struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Version int    `json:"version"`
}
type Container struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
	Ports  string `json:"ports"`
}
type Docker struct {
	Context    string      `json:"context"`
	Available  bool        `json:"available"`
	Error      string      `json:"error,omitempty"`
	Containers []Container `json:"containers"`
}
type Capabilities struct {
	Docker []string `json:"docker_actions"`
	WSL    []string `json:"wsl_actions"`
}
type Snapshot struct {
	V            int            `json:"v"`
	TS           int64          `json:"ts"`
	Host         string         `json:"host"`
	OS           string         `json:"os"`
	Arch         string         `json:"arch"`
	Agent        string         `json:"agent"`
	Uptime       uint64         `json:"uptime"`
	CPU          CPU            `json:"cpu"`
	Memory       Memory         `json:"memory"`
	Disks        []Disk         `json:"disks"`
	Network      []Network      `json:"network"`
	WSL          []Distribution `json:"wsl"`
	Docker       []Docker       `json:"docker"`
	Capabilities Capabilities   `json:"capabilities"`
	Errors       []string       `json:"errors"`
}
type Action struct {
	Target  string `json:"target"`
	Context string `json:"context,omitempty"`
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Action  string `json:"action"`
}
type Reply struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Unknown bool   `json:"unknown,omitempty"`
}
type runner func(context.Context, string, ...string) ([]byte, error)
type agent struct {
	run                       runner
	platform                  string
	dockerControl, wslControl bool
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 8*1024*1024 {
		return 0, fmt.Errorf("command output exceeds 8 MiB")
	}
	return b.Buffer.Write(p)
}
func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	configureCommand(cmd)
	cmd.WaitDelay = time.Second
	var out, stderr cappedBuffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		detail := strings.TrimSpace(decodeOutput(stderr.Bytes()))
		if detail == "" {
			detail = err.Error()
		}
		if len(detail) > 500 {
			detail = detail[:500]
		}
		return nil, fmt.Errorf("%s: %s", name, detail)
	}
	return out.Bytes(), nil
}
func decodeOutput(b []byte) string {
	// wsl.exe emits UTF-16LE when stdout is redirected, including --quiet.
	if (len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe) || bytes.IndexByte(b, 0) >= 0 {
		if len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe {
			b = b[2:]
		}
		v := make([]uint16, len(b)/2)
		for i := range v {
			v[i] = binary.LittleEndian.Uint16(b[i*2:])
		}
		return string(utf16.Decode(v))
	}
	return strings.TrimPrefix(string(b), "\ufeff")
}
func (a agent) capabilities() Capabilities {
	c := Capabilities{Docker: []string{}, WSL: []string{}}
	if a.dockerControl {
		c.Docker = []string{"start", "stop", "restart"}
	}
	if a.wslControl && a.platform == "windows" {
		c.WSL = []string{"start", "terminate"}
	}
	return c
}
func namesFromOutput(b []byte) []string {
	var out []string
	for _, line := range strings.Split(decodeOutput(b), "\n") {
		name := strings.TrimSpace(line)
		if name != "" && validDistribution(name) {
			out = append(out, name)
		}
	}
	return out
}
func validDistribution(name string) bool {
	if name == "" || len(name) > 256 || strings.HasPrefix(name, "-") {
		return false
	}
	for _, c := range name {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}
func (a agent) distributions(ctx context.Context) ([]Distribution, error) {
	out := []Distribution{}
	if a.platform != "windows" {
		return out, nil
	}
	all, err := a.run(ctx, "wsl.exe", "--list", "--quiet")
	if err != nil {
		return out, err
	}
	running, err := a.run(ctx, "wsl.exe", "--list", "--running", "--quiet")
	if err != nil {
		return out, err
	}
	active := map[string]bool{}
	for _, name := range namesFromOutput(running) {
		active[name] = true
	}
	verbose, _ := a.run(ctx, "wsl.exe", "--list", "--verbose")
	for _, name := range namesFromOutput(all) {
		d := Distribution{Name: name, State: "stopped"}
		if active[name] {
			d.State = "running"
		}
		for _, line := range strings.Split(decodeOutput(verbose), "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "*"))
			if strings.HasPrefix(line, name+" ") || strings.HasPrefix(line, name+"\t") {
				f := strings.Fields(line)
				if len(f) > 1 {
					d.Version, _ = strconv.Atoi(f[len(f)-1])
				}
			}
		}
		out = append(out, d)
	}
	return out, nil
}
func (a agent) dockerCommand(ctx context.Context, target string, args ...string) ([]byte, error) {
	// Pin the local socket: an inherited DOCKER_HOST/context must not silently
	// turn a local computer operation into one against another server.
	endpoint := "unix:///var/run/docker.sock"
	if target == "native" {
		if a.platform == "windows" {
			endpoint = "npipe:////./pipe/docker_engine"
		}
		return a.run(ctx, "docker", append([]string{"--host", endpoint}, args...)...)
	}
	if a.platform != "windows" || !strings.HasPrefix(target, "wsl:") || !validDistribution(strings.TrimPrefix(target, "wsl:")) {
		return nil, fmt.Errorf("invalid Docker context")
	}
	name := strings.TrimPrefix(target, "wsl:")
	// Check immediately before executing inside WSL: collection must not boot
	// an idle distribution merely to look for Docker.
	running, err := a.run(ctx, "wsl.exe", "--list", "--running", "--quiet")
	if err != nil {
		return nil, err
	}
	listed := false
	for _, n := range namesFromOutput(running) {
		if n == name {
			listed = true
		}
	}
	if !listed {
		return nil, fmt.Errorf("WSL distribution is stopped")
	}
	prefix := []string{"--distribution", name, "--exec", "docker", "--host", endpoint}
	return a.run(ctx, "wsl.exe", append(prefix, args...)...)
}
func (a agent) dockerInventory(ctx context.Context, target string) Docker {
	d := Docker{Context: target, Containers: []Container{}}
	b, err := a.dockerCommand(ctx, target, "container", "ls", "--all", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		d.Error = err.Error()
		return d
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var row struct{ ID, Names, Image, State, Status, Ports string }
		if err := json.Unmarshal([]byte(line), &row); err != nil || !containerID.MatchString(row.ID) {
			d.Error = "Invalid Docker inventory response"
			return d
		}
		d.Containers = append(d.Containers, Container{row.ID, row.Names, row.Image, row.State, row.Status, row.Ports})
	}
	d.Available = true
	return d
}
func (a agent) snapshot(ctx context.Context) Snapshot {
	host, _ := os.Hostname()
	s := Snapshot{V: 1, TS: time.Now().Unix(), Host: host, OS: a.platform, Arch: runtime.GOARCH, Agent: version,
		CPU: CPU{Cores: runtime.NumCPU()}, Disks: []Disk{}, Network: []Network{}, WSL: []Distribution{}, Docker: []Docker{}, Capabilities: a.capabilities(), Errors: []string{}}
	collectSystem(ctx, a.run, &s)
	wslctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	distros, err := a.distributions(wslctx)
	cancel()
	if err != nil {
		s.Errors = append(s.Errors, "WSL: "+err.Error())
	} else {
		s.WSL = distros
	}
	targets := []string{"native"}
	for _, d := range s.WSL {
		if d.State == "running" {
			targets = append(targets, "wsl:"+d.Name)
		} else {
			s.Docker = append(s.Docker, Docker{Context: "wsl:" + d.Name, Error: "WSL distribution is stopped", Containers: []Container{}})
		}
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for _, target := range targets {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			select {
			case limit <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-limit }()
			probe, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			d := a.dockerInventory(probe, target)
			mu.Lock()
			s.Docker = append(s.Docker, d)
			mu.Unlock()
		}(target)
	}
	wg.Wait()
	sort.Slice(s.Docker, func(i, j int) bool { return s.Docker[i].Context < s.Docker[j].Context })
	return s
}

var containerID = regexp.MustCompile(`^[0-9a-f]{64}$`)
var encodedRequest = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func decodeAction(encoded string) (Action, error) {
	var action Action
	if len(encoded) > 4096 || !encodedRequest.MatchString(encoded) {
		return action, fmt.Errorf("invalid encoded request")
	}
	b, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return action, fmt.Errorf("invalid encoded request")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&action); err != nil {
		return action, fmt.Errorf("invalid action: %w", err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return action, fmt.Errorf("trailing action data")
	}
	return action, nil
}
func (a agent) control(ctx context.Context, action Action) Reply {
	fail := func(msg string) Reply { return Reply{Error: msg} }
	var err error
	switch action.Target {
	case "docker":
		if !a.dockerControl {
			return fail("Docker control is disabled for this SSH key")
		}
		if action.Name != "" || !containerID.MatchString(action.ID) || (action.Action != "start" && action.Action != "stop" && action.Action != "restart") {
			return fail("invalid Docker action")
		}
		inventory := a.dockerInventory(ctx, action.Context)
		if !inventory.Available {
			return fail(inventory.Error)
		}
		var found *Container
		for _, c := range inventory.Containers {
			if c.ID == action.ID {
				copy := c
				found = &copy
				break
			}
		}
		if found == nil {
			return fail("container no longer exists in this context")
		}
		if action.Action == "start" && found.State != "exited" && found.State != "created" {
			return fail("container must be stopped before starting")
		}
		if action.Action != "start" && found.State != "running" {
			return fail("container must be running for this action")
		}
		args := []string{"container", action.Action}
		if action.Action != "start" {
			args = append(args, "--time", "20")
		}
		args = append(args, action.ID)
		_, err = a.dockerCommand(ctx, action.Context, args...)
	case "wsl":
		if !a.wslControl || a.platform != "windows" {
			return fail("WSL control is disabled for this SSH key")
		}
		if action.Context != "" || action.ID != "" || !validDistribution(action.Name) || (action.Action != "start" && action.Action != "terminate") {
			return fail("invalid WSL action")
		}
		distros, listErr := a.distributions(ctx)
		if listErr != nil {
			return fail(listErr.Error())
		}
		var found *Distribution
		for _, d := range distros {
			if d.Name == action.Name {
				copy := d
				found = &copy
				break
			}
		}
		if found == nil {
			return fail("WSL distribution is not registered for this SSH user")
		}
		if action.Action == "start" {
			if found.State != "stopped" {
				return fail("WSL distribution is already running")
			}
			_, err = a.run(ctx, "wsl.exe", "--distribution", action.Name, "--exec", "/bin/true")
		} else {
			if found.State != "running" {
				return fail("WSL distribution is already stopped")
			}
			_, err = a.run(ctx, "wsl.exe", "--terminate", action.Name)
		}
	default:
		return fail("unsupported action target")
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return Reply{OK: true, Unknown: true, Message: "Command timed out; result is unknown. Refresh state before retrying."}
	}
	if err != nil {
		return fail(err.Error())
	}
	message := "Command completed; refresh state"
	if action.Target == "wsl" && action.Action == "start" {
		message = "WSL boot requested; the distribution may stop automatically when idle"
	}
	return Reply{OK: true, Message: message}
}
func serve(argv []string, request string, envRequest bool, out io.Writer) int {
	a := agent{run: runCommand, platform: runtime.GOOS}
	for len(argv) > 0 && strings.HasPrefix(argv[0], "--") {
		switch argv[0] {
		case "--allow-docker-actions":
			a.dockerControl = true
		case "--allow-wsl-actions":
			a.wslControl = true
		default:
			json.NewEncoder(out).Encode(Reply{Error: "unsupported serve option"})
			return 2
		}
		argv = argv[1:]
	}
	if !envRequest {
		request = strings.Join(argv, " ")
	}
	encode := func(v any) int {
		if err := json.NewEncoder(out).Encode(v); err != nil {
			return 1
		}
		return 0
	}
	switch request {
	case "ping":
		host, _ := os.Hostname()
		return encode(map[string]any{"ok": true, "agent": version, "host": host, "os": runtime.GOOS, "capabilities": a.capabilities()})
	case "snapshot":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return encode(a.snapshot(ctx))
	case "capabilities":
		return encode(a.capabilities())
	}
	if strings.HasPrefix(request, "control ") {
		action, err := decodeAction(strings.TrimPrefix(request, "control "))
		if err != nil {
			encode(Reply{Error: err.Error()})
			return 2
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		result := a.control(ctx, action)
		encode(result)
		if !result.OK {
			return 2
		}
		return 0
	}
	encode(Reply{Error: "unsupported request"})
	return 2
}
func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: pc-agent serve [--allow-docker-actions] [--allow-wsl-actions] [ping|snapshot]")
		os.Exit(2)
	}
	request, present := os.LookupEnv("SSH_ORIGINAL_COMMAND")
	os.Exit(serve(os.Args[2:], request, present, os.Stdout))
}
