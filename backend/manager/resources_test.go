package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestClassifyGroups(t *testing.T) {
	procs := map[int]*procInfo{
		1:  {pid: 1, ppid: 0, comm: "init", cmdline: "/sbin/init"},
		10: {pid: 10, ppid: 1, comm: "mihomo", cmdline: "mihomo"},
		20: {pid: 20, ppid: 1, comm: "nginx", cmdline: "nginx: master process /usr/sbin/nginx -p /opt/etc/homenet/proxy/ -c /opt/etc/homenet/proxy/nginx.conf"},
		21: {pid: 21, ppid: 20, comm: "nginx", cmdline: "nginx: worker process"},
		30: {pid: 30, ppid: 1, comm: "nginx", cmdline: "nginx: master process /usr/sbin/nginx -e /dev/null"},
		31: {pid: 31, ppid: 30, comm: "nginx", cmdline: "nginx: worker process"},
		40: {pid: 40, ppid: 1, comm: "python3", cmdline: "/opt/bin/python3 /opt/foo/bar-app.py"},
		50: {pid: 50, ppid: 2, comm: "kworker/0:1", cmdline: ""},
		60: {pid: 60, ppid: 1, comm: "xkeen-net", cmdline: "xkeen-net -c /opt/etc/xkeen-net/config.json"},
	}
	extra := assignGroups(procs)
	want := map[int]string{10: "mihomo", 20: "homenet", 21: "homenet", 30: "webui", 31: "webui", 40: "opt-bar-app.py", 50: "kernel", 60: "xkeen-net"}
	for pid, group := range want {
		if procs[pid].group != group {
			t.Errorf("pid %d (%s): group %q, want %q", pid, procs[pid].cmdline, procs[pid].group, group)
		}
	}
	if extra["opt-bar-app.py"].name != "bar-app.py" {
		t.Errorf("unnamed Entware group: %+v", extra)
	}
}

// TestResourcesLive prints a real snapshot; run on the router with
// RESOURCES_LIVE=1 to check the /proc readers against the device.
func TestResourcesLive(t *testing.T) {
	if os.Getenv("RESOURCES_LIVE") != "1" {
		t.Skip("set RESOURCES_LIVE=1 on the router")
	}
	m := &resourceMonitor{}
	m.sample()
	time.Sleep(3 * time.Second)
	m.sample()
	body, _ := json.Marshal(m.snapshot)
	t.Log(string(body))
}
