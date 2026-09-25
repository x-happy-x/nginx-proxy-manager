package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// ROS_LIVE=1 runs raw commands against the real MikroTik (on the router,
// with MIKROTIK_CREDENTIALS_FILE). ROS_CMD="/cmd =a=b;/cmd2" overrides them.
func TestRouterOSLive(t *testing.T) {
	if os.Getenv("ROS_LIVE") != "1" {
		t.Skip("ROS_LIVE=1 to run against the real MikroTik")
	}
	creds, err := readROSCredentials(os.Getenv("MIKROTIK_CREDENTIALS_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dialROS(creds, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	commands := os.Getenv("ROS_CMD")
	if commands == "" {
		commands = "/system/resource/print"
	}
	for _, command := range strings.Split(commands, ";") {
		started := time.Now()
		reply, err := conn.Run(40*time.Second, strings.Fields(command)...)
		t.Logf("%s (%s): err=%v", command, time.Since(started).Round(time.Millisecond), err)
		for _, row := range reply.Rows {
			t.Logf("  re %v", row)
		}
		t.Logf("  done %v", reply.Done)
	}
}
