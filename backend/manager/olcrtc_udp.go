package main

import (
	_ "embed"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// UDP through OLCRTC: the server runs a relay beside olcrtc — the fork's core
// as a Shadowsocks UoT server on its loopback (olcrtc_udp_relay.sh, the same
// script as mihomo/scripts/olcrtc-udp/install-relay.sh) — and every node of
// the server gets udp-relay. The script also guards the server: olcrtc's
// clients reach the internet, DNS and the relay, not its loopback or private
// networks.

//go:embed olcrtc_udp_relay.sh
var olcRelayScript string

const (
	olcRelayPort    = 18443
	olcRelayRelease = "https://github.com/x-happy-x/mihomo/releases"
)

var olcRelayOut = regexp.MustCompile(`(?m)^RELAY (\d+) (\S+)$`)

// olcRelayOption: the node option for the server's relay, nil without one.
func olcRelayOption(srv *olcServer) map[string]any {
	if srv == nil || srv.UDPKey == "" || srv.UDPPort == 0 {
		return nil
	}
	return map[string]any{"server": "127.0.0.1", "port": srv.UDPPort, "cipher": "aes-128-gcm", "password": srv.UDPKey}
}

func olcWithRelay(node map[string]any, srv *olcServer) map[string]any {
	if r := olcRelayOption(srv); r != nil {
		node["udp-relay"] = r
	}
	return node
}

// olcRelayArch: the release's name for the server's architecture.
func olcRelayArch(arch string) string {
	switch arch {
	case "amd64":
		return "linux-amd64-v1"
	case "arm64":
		return "linux-arm64"
	}
	return ""
}

// olcRelayCommand: install the relay when the server has none, or keep the
// one it has and refresh the guard; prints "RELAY <port> <password>".
func olcRelayCommand(arch string) string {
	name := olcRelayArch(arch)
	install := "echo 'нет сборки ядра для архитектуры " + arch + "' >&2; exit 1"
	if name != "" {
		install = fmt.Sprintf(`v=$(curl -fsSL --max-time 60 %[1]s/latest/download/version.txt) && curl -fsSL --max-time 600 -o /tmp/olcrtc-udp.gz %[1]s/download/$v/mihomo-%[2]s-$v.gz && sh -s /tmp/olcrtc-udp.gz %[3]d <<'HOMENET_RELAY'
%[4]s
HOMENET_RELAY
rc=$?; rm -f /tmp/olcrtc-udp.gz; [ $rc = 0 ] || exit $rc`, olcRelayRelease, name, olcRelayPort, olcRelayScript)
	}
	return fmt.Sprintf(`if systemctl is-active -q olcrtc-udp && [ -s /opt/olcrtc-udp/password ]; then p=$(awk '/^    port:/{print $2; exit}' /opt/olcrtc-udp/config.yaml); sh -s --guard "$p" <<'HOMENET_RELAY'
%[1]s
HOMENET_RELAY
else
%[2]s
fi
p=$(awk '/^    port:/{print $2; exit}' /opt/olcrtc-udp/config.yaml) && printf 'RELAY %%s %%s\n' "$p" "$(cat /opt/olcrtc-udp/password)"`, olcRelayScript, install)
}

// ensureRelay installs or reads the server's relay, then puts udp-relay on
// the server's nodes on the router.
func (o *olcState) ensureRelay(x *olcSSH, srv *olcServer) (string, error) {
	cmd := olcRelayCommand(srv.Arch)
	out, err := x.root(cmd, 12*time.Minute)
	m := olcRelayOut.FindStringSubmatch(out)
	if err != nil || m == nil {
		if err == nil {
			err = errors.New("реле не ответило")
		}
		return "", fmt.Errorf("%s: %s", err, olcLast(olcRelayOut.ReplaceAllString(out, "")))
	}
	port, _ := strconv.Atoi(m[1])
	o.mu.Lock()
	srv.UDPPort, srv.UDPKey = port, m[2]
	variants := append([]olcVariant(nil), srv.Variants...)
	o.saveLocked()
	o.mu.Unlock()
	n := 0
	for _, v := range variants {
		if err := mihomoDo(http.MethodPut, "/providers/proxies/"+url.PathEscape(olcProvider)+"/proxies/"+url.PathEscape(v.Node),
			map[string]any{"udp-relay": olcRelayOption(srv)}, nil, 15*time.Second); err == nil {
			n++
		}
	}
	guard := ""
	if strings.Contains(out, "guard: on") {
		guard = ", loopback и частные сети сервера закрыты для клиентов"
	}
	return fmt.Sprintf("UDP через реле на 127.0.0.1:%d, узлов с UDP: %d%s", port, n, guard), nil
}

// Servers set up before the relay existed: the background tidy reads the
// relay once it is there (installed by hand or by a later setup), at most
// once an hour per server.
var (
	olcRelayTriedMu sync.Mutex
	olcRelayTried   = map[string]time.Time{}
)

func (o *olcState) learnRelay(srv *olcServer) {
	o.mu.Lock()
	known := srv.UDPKey != ""
	o.mu.Unlock()
	if known {
		return
	}
	olcRelayTriedMu.Lock()
	if time.Since(olcRelayTried[srv.ID]) < time.Hour {
		olcRelayTriedMu.Unlock()
		return
	}
	olcRelayTried[srv.ID] = time.Now()
	olcRelayTriedMu.Unlock()
	x, _, err := olcDial(srv, "")
	if err != nil {
		return
	}
	defer x.c.Close()
	out, err := x.root(`[ -s /opt/olcrtc-udp/password ] && systemctl is-active -q olcrtc-udp && printf 'RELAY %s %s\n' "$(awk '/^    port:/{print $2; exit}' /opt/olcrtc-udp/config.yaml)" "$(cat /opt/olcrtc-udp/password)"`, 30*time.Second)
	m := olcRelayOut.FindStringSubmatch(out)
	if err != nil || m == nil {
		return
	}
	port, _ := strconv.Atoi(m[1])
	o.mu.Lock()
	srv.UDPPort, srv.UDPKey = port, m[2]
	o.saveLocked()
	o.mu.Unlock()
	o.event("ok", srv.Name+": найдено UDP-реле, новые узлы получат UDP")
}
