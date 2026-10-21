package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

const testID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func row(state string) []byte {
	return []byte(fmt.Sprintf(`{"ID":%q,"Names":"web","Image":"nginx","State":%q,"Status":"Up 1 hour","Ports":"80/tcp"}`, testID, state))
}
func TestControlDisabled(t *testing.T) {
	a := agent{platform: "windows", run: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("read-only key ran a process")
		return nil, nil
	}}
	for _, action := range []Action{{Target: "docker", Context: "native", ID: testID, Action: "stop"}, {Target: "wsl", Name: "Ubuntu", Action: "terminate"}} {
		if a.control(context.Background(), action).OK {
			t.Fatalf("allowed disabled control: %+v", action)
		}
	}
}
func TestCapabilitiesSeparatePermissions(t *testing.T) {
	a := agent{platform: "windows", dockerControl: true}
	if len(a.capabilities().Docker) != 3 || len(a.capabilities().WSL) != 0 {
		t.Fatal(a.capabilities())
	}
	a = agent{platform: "linux", wslControl: true}
	if len(a.capabilities().WSL) != 0 {
		t.Fatal("WSL advertised on Linux")
	}
}
func TestActionDecoderRejectsShellAndUnknownFields(t *testing.T) {
	for _, payload := range []string{`{"target":"docker","command":"rm -rf /"}`, `{} {}`, `[]`, `null extra`} {
		if _, err := decodeAction(base64.RawURLEncoding.EncodeToString([]byte(payload))); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
	for _, value := range []string{"", "YWJj;reboot", "YQ==", strings.Repeat("A", 4097), "YQ\n"} {
		if _, err := decodeAction(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
func TestSSHRequestCannotGrantPermissions(t *testing.T) {
	var out bytes.Buffer
	code := serve(nil, "--allow-docker-actions control e30", true, &out)
	if code != 2 || !strings.Contains(out.String(), "unsupported request") {
		t.Fatal(code, out.String())
	}
	out.Reset()
	code = serve([]string{"--allow-docker-actions"}, "capabilities", true, &out)
	if code != 0 || !strings.Contains(out.String(), `"start"`) {
		t.Fatal(code, out.String())
	}
}
func TestDockerLocalEndpointAndExactArgumentArray(t *testing.T) {
	for _, platform := range []string{"windows", "linux"} {
		for _, action := range []string{"start", "stop", "restart"} {
			t.Run(platform+"/"+action, func(t *testing.T) {
				calls := [][]string{}
				a := agent{platform: platform, dockerControl: true, run: func(_ context.Context, name string, args ...string) ([]byte, error) {
					calls = append(calls, append([]string{name}, args...))
					if len(calls) == 1 {
						state := "running"
						if action == "start" {
							state = "exited"
						}
						return row(state), nil
					}
					return []byte(testID), nil
				}}
				result := a.control(context.Background(), Action{Target: "docker", Context: "native", ID: testID, Action: action})
				if !result.OK || result.Unknown {
					t.Fatal(result)
				}
				endpoint := "unix:///var/run/docker.sock"
				if platform == "windows" {
					endpoint = "npipe:////./pipe/docker_engine"
				}
				expected := []string{"docker", "--host", endpoint, "container", action}
				if action != "start" {
					expected = append(expected, "--time", "20")
				}
				expected = append(expected, testID)
				if len(calls) != 2 || !reflect.DeepEqual(calls[1], expected) {
					t.Fatalf("calls: %q", calls)
				}
			})
		}
	}
}
func TestDockerRejectsInvalidOrStaleTargets(t *testing.T) {
	for _, action := range []Action{{Target: "docker", Context: "native", ID: "--all", Action: "stop"}, {Target: "docker", Context: "native", ID: testID, Action: "rm"}, {Target: "docker", Context: "native", ID: testID, Action: "stop", Name: "injected"}} {
		a := agent{dockerControl: true, run: func(context.Context, string, ...string) ([]byte, error) {
			t.Fatal("invalid request ran command")
			return nil, nil
		}}
		if a.control(context.Background(), action).OK {
			t.Fatalf("accepted %+v", action)
		}
	}
	for _, inventory := range [][]byte{nil, row("paused"), row("exited"), []byte("not JSON")} {
		calls := 0
		a := agent{platform: "linux", dockerControl: true, run: func(context.Context, string, ...string) ([]byte, error) { calls++; return inventory, nil }}
		if a.control(context.Background(), Action{Target: "docker", Context: "native", ID: testID, Action: "stop"}).OK {
			t.Fatal("accepted stale container")
		}
		if calls != 1 {
			t.Fatal("mutation was attempted")
		}
	}
}
func TestDockerTimeoutUnknownWithoutRetry(t *testing.T) {
	calls := 0
	a := agent{platform: "linux", dockerControl: true, run: func(context.Context, string, ...string) ([]byte, error) {
		calls++
		if calls == 1 {
			return row("running"), nil
		}
		return nil, context.DeadlineExceeded
	}}
	result := a.control(context.Background(), Action{Target: "docker", Context: "native", ID: testID, Action: "stop"})
	if !result.OK || !result.Unknown || calls != 2 {
		t.Fatal(result, calls)
	}
}
func TestStoppedWSLNeverProbedForDocker(t *testing.T) {
	a := agent{platform: "windows", run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "wsl.exe" || !reflect.DeepEqual(args, []string{"--list", "--running", "--quiet"}) {
			t.Fatalf("unexpected process: %s %q", name, args)
		}
		return []byte("Other\n"), nil
	}}
	d := a.dockerInventory(context.Background(), "wsl:Stopped Ubuntu")
	if d.Available || !strings.Contains(d.Error, "stopped") {
		t.Fatal(d)
	}
}
func TestWSLDockerUsesArgumentArrayAndChecksRunning(t *testing.T) {
	calls := [][]string{}
	a := agent{platform: "windows", run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		if len(calls) == 1 {
			return []byte("Ubuntu Work\n"), nil
		}
		return row("running"), nil
	}}
	d := a.dockerInventory(context.Background(), "wsl:Ubuntu Work")
	if !d.Available || len(calls) != 2 {
		t.Fatal(d, calls)
	}
	expected := []string{"wsl.exe", "--distribution", "Ubuntu Work", "--exec", "docker", "--host", "unix:///var/run/docker.sock", "container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"}
	if !reflect.DeepEqual(calls[1], expected) {
		t.Fatalf("%q", calls[1])
	}
}
func TestWSLInventoryLocalizationAndUTF16(t *testing.T) {
	encode := func(s string) []byte {
		units := utf16.Encode([]rune(s))
		b := make([]byte, len(units)*2)
		for i, u := range units {
			binary.LittleEndian.PutUint16(b[i*2:], u)
		}
		return b
	}
	a := agent{platform: "windows", run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		switch strings.Join(args, " ") {
		case "--list --quiet":
			return encode("Ubuntu Work\r\nDebian\r\n"), nil
		case "--list --running --quiet":
			return encode("Ubuntu Work\r\n"), nil
		default:
			return encode("ИМЯ   СОСТОЯНИЕ   ВЕРСИЯ\r\n* Ubuntu Work     Работает     2\r\n  Debian          Остановлен   1\r\n"), nil
		}
	}}
	distros, err := a.distributions(context.Background())
	if err != nil || !reflect.DeepEqual(distros, []Distribution{{"Ubuntu Work", "running", 2}, {"Debian", "stopped", 1}}) {
		t.Fatal(distros, err)
	}
}
func TestWSLControlsRequireRegisteredExactNameAndState(t *testing.T) {
	for _, action := range []string{"start", "terminate"} {
		t.Run(action, func(t *testing.T) {
			calls := [][]string{}
			a := agent{platform: "windows", wslControl: true, run: func(_ context.Context, name string, args ...string) ([]byte, error) {
				calls = append(calls, append([]string{name}, args...))
				switch strings.Join(args, " ") {
				case "--list --quiet":
					return []byte("Ubuntu Work\n"), nil
				case "--list --running --quiet":
					if action == "terminate" {
						return []byte("Ubuntu Work\n"), nil
					}
					return nil, nil
				case "--list --verbose":
					return nil, nil
				default:
					return nil, nil
				}
			}}
			result := a.control(context.Background(), Action{Target: "wsl", Name: "Ubuntu Work", Action: action})
			if !result.OK || len(calls) != 4 {
				t.Fatal(result, calls)
			}
			want := []string{"wsl.exe", "--terminate", "Ubuntu Work"}
			if action == "start" {
				want = []string{"wsl.exe", "--distribution", "Ubuntu Work", "--exec", "/bin/true"}
			}
			if !reflect.DeepEqual(calls[3], want) {
				t.Fatal(calls[3])
			}
			calls = nil
			result = a.control(context.Background(), Action{Target: "wsl", Name: "Ubuntu Work;whoami", Action: action})
			if result.OK || len(calls) != 3 {
				t.Fatal(result, calls)
			}
		})
	}
}
func TestActionRoundTrip(t *testing.T) {
	want := Action{Target: "wsl", Name: "Ubuntu Work", Action: "start"}
	b, _ := json.Marshal(want)
	got, err := decodeAction(base64.RawURLEncoding.EncodeToString(b))
	if err != nil || got != want {
		t.Fatal(got, err)
	}
}
