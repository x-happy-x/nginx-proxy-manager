#!/bin/sh
# UDP relay for OLCRTC (docs/olcrtc-udp.md): the core itself as a Shadowsocks
# server on loopback with UDP-over-TCP, beside the olcrtc server. olcrtc dials
# 127.0.0.1:PORT for the client; HomeNet rebuilding olcrtc does not touch it.
#
#   install-relay.sh <mihomo.gz> [port]     install or update, prints the client options
#   install-relay.sh --guard [port]         only the guard below
#   install-relay.sh --remove               stop and delete
#
# The guard: olcrtc dials whatever its clients ask, the server's own loopback
# and private networks included (docker, the provider's LAN). An nft rule on
# the olcrtc@ services' cgroup leaves them the internet, DNS and the relay.
set -eu

DIR=/opt/olcrtc-udp
UNIT=/etc/systemd/system/olcrtc-udp.service
DROPIN=/etc/systemd/system/olcrtc@.service.d/homenet-guard.conf
PORT=${2:-18443}

guard() {
    mkdir -p "$DIR" "$(dirname "$DROPIN")"
    {
        echo '#!/bin/sh'
        echo '# HomeNet: olcrtc clients reach the internet, DNS and the UDP relay only'
        echo 'nft delete table inet homenet_olcrtc 2>/dev/null'
        echo '[ -d /sys/fs/cgroup/system.slice/system-olcrtc.slice ] || exit 0'
        echo "printf '%s\\n' \\"
        echo "  'table inet homenet_olcrtc {' \\"
        echo "  '  chain out {' \\"
        echo "  '    type filter hook output priority 0; policy accept;' \\"
        echo "  '    socket cgroupv2 level 2 \"system.slice/system-olcrtc.slice\" oifname \"lo\" meta l4proto tcp tcp dport != { 53, $PORT } reject with tcp reset' \\"
        echo "  '    socket cgroupv2 level 2 \"system.slice/system-olcrtc.slice\" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject' \\"
        echo "  '  }' '}' | nft -f -"
    } > "$DIR/guard.sh"
    chmod 0755 "$DIR/guard.sh"
    # every start of a variant (its slice exists then) puts the rule back
    printf '[Service]\nExecStartPost=-%s/guard.sh\n' "$DIR" > "$DROPIN"
    systemctl daemon-reload
    if command -v nft >/dev/null 2>&1; then
        "$DIR/guard.sh" && echo "guard: on"
    else
        echo "guard: nft not found, skipped" >&2
    fi
}

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
    systemctl disable --now olcrtc-udp >/dev/null 2>&1 || true
    nft delete table inet homenet_olcrtc 2>/dev/null || true
    rm -rf "$DIR" "$UNIT" "$DROPIN"
    systemctl daemon-reload
    echo "removed"
    exit 0
fi

if [ "${1:-}" = "--guard" ]; then
    guard
    exit 0
fi

[ -f "${1:-}" ] || { echo "usage: install-relay.sh <mihomo.gz> [port] | --remove" >&2; exit 2; }

mkdir -p "$DIR"
gzip -cd "$1" > "$DIR/mihomo.new"
chmod 0755 "$DIR/mihomo.new"
"$DIR/mihomo.new" -v

if [ -s "$DIR/password" ]; then
    password=$(cat "$DIR/password")
else
    password=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
    umask 077
    printf %s "$password" > "$DIR/password"
fi

# Only the internet: the relay must not become a way into the server's own
# services (loopback, docker, the provider's private network).
cat > "$DIR/config.yaml" <<EOF
mode: rule
log-level: warning
ipv6: false
allow-lan: false
bind-address: 127.0.0.1
external-controller: ''
profile:
  store-selected: false
  store-fake-ip: false
listeners:
  - name: olcrtc-udp
    type: shadowsocks
    listen: 127.0.0.1
    port: $PORT
    cipher: aes-128-gcm
    password: "$password"
    udp: false
rules:
  - IP-CIDR,0.0.0.0/8,REJECT,no-resolve
  - IP-CIDR,10.0.0.0/8,REJECT,no-resolve
  - IP-CIDR,100.64.0.0/10,REJECT,no-resolve
  - IP-CIDR,127.0.0.0/8,REJECT,no-resolve
  - IP-CIDR,169.254.0.0/16,REJECT,no-resolve
  - IP-CIDR,172.16.0.0/12,REJECT,no-resolve
  - IP-CIDR,192.168.0.0/16,REJECT,no-resolve
  - IP-CIDR,224.0.0.0/3,REJECT,no-resolve
  - MATCH,DIRECT
EOF
chmod 0600 "$DIR/config.yaml"
"$DIR/mihomo.new" -t -d "$DIR" -f "$DIR/config.yaml" >/dev/null
[ -f "$DIR/mihomo" ] && cp -p "$DIR/mihomo" "$DIR/mihomo.prev"
mv "$DIR/mihomo.new" "$DIR/mihomo"

cat > "$UNIT" <<EOF
[Unit]
Description=UDP relay for olcrtc (Shadowsocks UoT on loopback, HomeNet)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$DIR/mihomo -d $DIR -f $DIR/config.yaml
Restart=always
RestartSec=3
MemoryMax=128M
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DIR
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable olcrtc-udp >/dev/null 2>&1
systemctl restart olcrtc-udp
sleep 3
systemctl is-active olcrtc-udp
ss -ltn | grep -q "127.0.0.1:$PORT " || { echo "relay is not listening on $PORT" >&2; exit 1; }
guard

echo "client options for every OLCRTC node of this server:"
echo "    udp-relay: {server: 127.0.0.1, port: $PORT, cipher: aes-128-gcm, password: \"$password\"}"
