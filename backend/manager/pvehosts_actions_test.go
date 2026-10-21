package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testPVHUPID = "UPID:s1:0000537D:00060745:58C2590F:qmstart:101:root@pam:"

func pvhActionsMonitor(t *testing.T) *pvhMonitor {
	t.Helper()
	m := pvhTestMonitor(t, time.Now().Unix())
	m.hosts[0].Capabilities = pvhCapabilities{Control: true, GuestActions: []string{"start", "shutdown", "reboot", "stop"}, NodeActions: []string{"reboot", "shutdown"}}
	return m
}

func TestPVEActionRejectsUnsafeTargetsBeforeSSH(t *testing.T) {
	tests := []struct {
		name   string
		action pvhAction
		change func(*pvhMonitor)
		status int
	}{
		{"unknown host", pvhAction{Host: "missing", Target: "node", Action: "reboot", Confirm: "missing"}, nil, 404},
		{"shell host", pvhAction{Host: "s1;reboot", Target: "node", Action: "reboot"}, nil, 400},
		{"node confirmation", pvhAction{Host: "s1", Target: "node", Action: "reboot"}, nil, 400},
		{"guest confirmation", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 100, Action: "stop", Confirm: "s1"}, nil, 400},
		{"unknown action", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "destroy"}, nil, 400},
		{"wrong type", pvhAction{Host: "s1", Target: "guest", Type: "lxc", VMID: 101, Action: "start"}, nil, 404},
		{"missing guest", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 102, Action: "start"}, nil, 404},
		{"running guest start", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 100, Action: "start"}, nil, 409},
		{"template", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 9999, Action: "start"}, nil, 409},
		{"locked", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}, func(m *pvhMonitor) { m.hosts[0].Parsed.Guests[1].Lock = "backup" }, 409},
		{"stale", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}, func(m *pvhMonitor) { m.hosts[0].Parsed.TS -= 100 }, 409},
		{"offline", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}, func(m *pvhMonitor) { m.hosts[0].Online = false }, 409},
		{"old agent", pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}, func(m *pvhMonitor) { m.hosts[0].Capabilities = pvhCapabilities{} }, 403},
		{"guest-only key", pvhAction{Host: "s1", Target: "node", Action: "reboot", Confirm: "s1"}, func(m *pvhMonitor) { m.hosts[0].Capabilities.NodeActions = nil }, 403},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := pvhActionsMonitor(t)
			if tt.change != nil {
				tt.change(m)
			}
			m.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
				t.Fatal("unsafe request reached SSH")
				return nil, nil
			}
			_, status, err := m.executeAction(context.Background(), tt.action)
			if err == nil || status != tt.status {
				t.Fatalf("got status %d, err %v", status, err)
			}
		})
	}
}

func TestPVEGuestTaskLifecycleAndDuplicate(t *testing.T) {
	m := pvhActionsMonitor(t)
	var calls []string
	m.request = func(_ context.Context, cfg pvhHostConfig, request string) ([]byte, error) {
		calls = append(calls, request)
		if cfg.ID != "s1" {
			t.Fatal("wrong server")
		}
		if strings.HasPrefix(request, "control ") {
			return []byte(`{"ok":true,"upid":"` + testPVHUPID + `"}`), nil
		}
		return []byte(`{"ok":true,"status":"stopped","exitstatus":"OK"}`), nil
	}
	a := pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}
	task, _, err := m.executeAction(context.Background(), a)
	if err != nil || task.Status != "running" || task.UPID != testPVHUPID {
		t.Fatalf("task: %+v %v", task, err)
	}
	if _, status, err := m.executeAction(context.Background(), a); err == nil || status != 409 {
		t.Fatal("duplicate task accepted")
	}
	if _, status, err := m.executeAction(context.Background(), pvhAction{Host: "s1", Target: "node", Action: "reboot", Confirm: "s1"}); err == nil || status != 409 {
		t.Fatal("node reboot during guest operation accepted")
	}
	m.pollTasks()
	if got := m.taskList(); len(got) != 1 || got[0].Status != "done" {
		t.Fatalf("tasks: %+v", got)
	}
	if len(calls) != 2 || calls[0] != "control guest qemu 101 start" || calls[1] != "task "+testPVHUPID {
		t.Fatalf("commands: %v", calls)
	}
}

func TestPVELXCGracefulShutdown(t *testing.T) {
	m := pvhActionsMonitor(t)
	m.hosts[0].Parsed.Guests[0].Type = "lxc"
	m.request = func(_ context.Context, _ pvhHostConfig, request string) ([]byte, error) {
		if request != "control guest lxc 100 shutdown" {
			t.Fatal(request)
		}
		return []byte(`{"ok":true,"upid":"UPID:s1:0000537D:00060745:58C2590F:vzshutdown:100:root@pam:"}`), nil
	}
	task, _, err := m.executeAction(context.Background(), pvhAction{Host: "s1", Target: "guest", Type: "lxc", VMID: 100, Action: "shutdown", Confirm: "100"})
	if err != nil || task.Status != "running" {
		t.Fatalf("task %+v err %v", task, err)
	}
}

func TestPVENodeAcceptanceAndUncertainOutcome(t *testing.T) {
	for _, tt := range []struct {
		name, body, want string
		err              error
	}{
		{"accepted", `{"ok":true}`, "accepted", nil},
		{"timeout", "", "unknown", context.DeadlineExceeded},
		{"bad response", "unexpected output", "unknown", nil},
		{"rejected", `{"ok":false,"error":"node actions disabled"}`, "error", errors.New("exit status 1")},
		{"agent timeout", `{"ok":false,"unknown":true,"error":"timeout"}`, "unknown", nil},
		{"invalid upid", `{"ok":true,"upid":"UPID:x/../../etc/passwd:"}`, "unknown", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := pvhActionsMonitor(t)
			calls := 0
			m.request = func(_ context.Context, _ pvhHostConfig, request string) ([]byte, error) {
				calls++
				if request != "control node reboot" {
					t.Fatal(request)
				}
				return []byte(tt.body), tt.err
			}
			task, _, err := m.executeAction(context.Background(), pvhAction{Host: "s1", Target: "node", Action: "reboot", Confirm: "s1"})
			if err != nil || task.Status != tt.want {
				t.Fatalf("task %+v err %v", task, err)
			}
			m.pollTasks()
			if calls != 1 {
				t.Fatal("uncertain action was executed again")
			}
			if tt.want == "unknown" || tt.want == "accepted" {
				_, status, err := m.executeAction(context.Background(), pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"})
				if status != 409 || err == nil {
					t.Fatal("uncertain node operation must temporarily block dependent commands")
				}
			}
		})
	}
}

func TestPVEConcurrentActionsReserveTarget(t *testing.T) {
	m := pvhActionsMonitor(t)
	started, release := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	m.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
		if count.Add(1) == 1 {
			close(started)
		}
		<-release
		return []byte(`{"ok":true,"upid":"` + testPVHUPID + `"}`), nil
	}
	a := pvhAction{Host: "s1", Target: "guest", Type: "qemu", VMID: 101, Action: "start"}
	done := make(chan struct{})
	go func() { defer close(done); _, _, _ = m.executeAction(context.Background(), a) }()
	<-started
	_, status, err := m.executeAction(context.Background(), a)
	close(release)
	<-done
	if err == nil || status != 409 || count.Load() != 1 {
		t.Fatalf("duplicate: %d %v count %d", status, err, count.Load())
	}
}

func TestPVETaskPollingKeepsUncertainStatusAndReportsFailure(t *testing.T) {
	m := pvhActionsMonitor(t)
	now := time.Now()
	m.tasks = []*pvhTask{{ID: "one", Host: "s1", Status: "running", UPID: testPVHUPID, created: now}}
	m.request = func(context.Context, pvhHostConfig, string) ([]byte, error) { return nil, errors.New("offline") }
	m.pollTasks()
	if m.tasks[0].Status != "running" {
		t.Fatal("temporary connection failure must not claim execution failed")
	}
	m.tasks[0].created = now.Add(-16 * time.Minute)
	m.pollTasks()
	if m.tasks[0].Status != "unknown" {
		t.Fatal("lost task must eventually become unknown")
	}
	m.tasks[0].Status = "running"
	m.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
		return []byte(`{"ok":true,"status":"stopped","exitstatus":"unable to acquire lock"}`), nil
	}
	m.pollTasks()
	if m.tasks[0].Status != "error" || m.tasks[0].Message != "unable to acquire lock" {
		t.Fatal("failed task exitstatus lost")
	}
}

func TestPVEActionHTTPAndTaskList(t *testing.T) {
	old := pvh
	t.Cleanup(func() { pvh = old })
	pvh = pvhActionsMonitor(t)
	pvh.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
		return []byte(`{"ok":true,"upid":"` + testPVHUPID + `"}`), nil
	}
	for _, body := range []string{`{`, `{"host":"s1","command":"rm -rf /"}`, `{} {}`} {
		rec := httptest.NewRecorder()
		(&app{}).handlePVE(rec, httptest.NewRequest("POST", "/api/pve/actions", strings.NewReader(body)))
		if rec.Code != 400 {
			t.Fatalf("invalid body: %s %d", body, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("POST", "/api/pve/actions", strings.NewReader(`{"host":"s1","target":"guest","type":"qemu","vmid":101,"action":"start"}`)))
	if rec.Code != 202 {
		t.Fatalf("submit: %d %s", rec.Code, rec.Body.String())
	}
	pvh.request = func(context.Context, pvhHostConfig, string) ([]byte, error) {
		t.Fatal("task list must be cache-only")
		return nil, nil
	}
	rec = httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("GET", "/api/pve/tasks", nil))
	var out struct {
		Tasks []pvhTask `json:"tasks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != 200 || len(out.Tasks) != 1 {
		t.Fatalf("tasks: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/pve/actions", "/api/pve/tasks"} {
		rec = httptest.NewRecorder()
		(&app{}).handlePVE(rec, httptest.NewRequest("DELETE", path, nil))
		if rec.Code != 405 {
			t.Fatalf("method: %s %d", path, rec.Code)
		}
	}
}

func TestPVETasksRemainBounded(t *testing.T) {
	m := pvhActionsMonitor(t)
	for i := 0; i < 100; i++ {
		m.tasks = append(m.tasks, &pvhTask{Status: "done", created: time.Now().Add(-time.Hour)})
	}
	m.request = func(context.Context, pvhHostConfig, string) ([]byte, error) { return []byte(`{"ok":true}`), nil }
	if _, _, err := m.executeAction(context.Background(), pvhAction{Host: "s1", Target: "node", Action: "reboot", Confirm: "s1"}); err != nil {
		t.Fatal(err)
	}
	if len(m.tasks) != 100 {
		t.Fatal("task history grew beyond bound")
	}
}
