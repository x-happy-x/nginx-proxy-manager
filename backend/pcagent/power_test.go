package main

import (
	"context"
	"reflect"
	"testing"
)

func TestComputerShutdownRequiresExplicitKeyPermission(t *testing.T) {
	calls := 0
	a := agent{platform: "windows", run: func(context.Context, string, ...string) ([]byte, error) { calls++; return nil, nil }}
	action := Action{Target: "power", Action: "shutdown"}
	if a.control(context.Background(), action).OK || calls != 0 {
		t.Fatal("readonly key switched off computer")
	}
	a.powerControl = true
	a.run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls++
		if name != "shutdown.exe" || !reflect.DeepEqual(args, []string{"/s", "/t", "0"}) {
			t.Fatalf("forced or wrong shutdown: %s %v", name, args)
		}
		return nil, nil
	}
	if !a.control(context.Background(), action).OK || calls != 1 {
		t.Fatal("permitted shutdown failed")
	}
	for _, bad := range []Action{{Target: "power", Action: "reboot"}, {Target: "power", Action: "shutdown", Context: "native"}, {Target: "power", Action: "shutdown", Name: "pc"}} {
		if a.control(context.Background(), bad).OK {
			t.Fatal("invalid power command accepted")
		}
	}
	if calls != 1 {
		t.Fatal("rejected action executed")
	}
}
