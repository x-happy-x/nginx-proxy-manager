#!/bin/sh
# Installs the HomeNet agent on a Proxmox VE host and authorizes HomeNet's key
# for the read-only forced command only. Run as root on the host:
#   sh install.sh 'ssh-ed25519 AAAA... homenet-pve@router'
# Files homenet-pve-agent and homenet-pve-agent.service must sit next to it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${1:-}"

install -m 0755 "$HERE/homenet-pve-agent" /usr/local/bin/homenet-pve-agent
install -m 0644 "$HERE/homenet-pve-agent.service" /etc/systemd/system/homenet-pve-agent.service
systemctl daemon-reload
systemctl enable homenet-pve-agent.service >/dev/null
systemctl restart homenet-pve-agent.service

if [ -n "$KEY" ]; then
  case "$KEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "not a public key" >&2; exit 1 ;; esac
  AUTH=/root/.ssh/authorized_keys
  [ -L "$AUTH" ] && AUTH="$(readlink -f "$AUTH")"   # Proxmox links it to /etc/pve/priv
  BODY="$(echo "$KEY" | awk '{print $2}')"
  LINE="restrict,command=\"/usr/local/bin/homenet-pve-agent serve\" $KEY"
  if grep -q "$BODY" "$AUTH" 2>/dev/null; then
    grep -v "$BODY" "$AUTH" > "$AUTH.homenet.tmp" || true
    cat "$AUTH.homenet.tmp" > "$AUTH" && rm -f "$AUTH.homenet.tmp"
  fi
  echo "$LINE" >> "$AUTH"
fi

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [ -s /run/homenet-pve/current.json ] && break
  sleep 1
done
/usr/local/bin/homenet-pve-agent serve ping
