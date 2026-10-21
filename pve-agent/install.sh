#!/bin/sh
# Installs the HomeNet agent on a Proxmox VE host and authorizes HomeNet's key
# for a restricted forced command (read-only unless flags are provided).
#   sh install.sh 'ssh-ed25519 AAAA... homenet-pve@router' [--allow-guest-actions] [--allow-node-actions]
# Files homenet-pve-agent and homenet-pve-agent.service must sit next to it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
FLAGS=""
for option in "$@"; do
  case "$option" in
    --allow-guest-actions|--allow-node-actions) FLAGS="$FLAGS $option" ;;
    *) echo "unknown option: $option" >&2; exit 1 ;;
  esac
done
if [ -n "$FLAGS" ] && [ -z "$KEY" ]; then
  echo "pass the HomeNet public key when enabling control" >&2
  exit 1
fi
# Validate before updating the service or authorized_keys. In particular, a
# public-key comment must not inject another authorized_keys line.
if [ -n "$KEY" ]; then
  printf '%s' "$KEY" | python3 -c '
import base64, struct, sys
try:
    key = sys.stdin.read()
    assert "\n" not in key and "\r" not in key
    parts = key.split()
    assert len(parts) >= 2 and parts[0] in ("ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521")
    raw = base64.b64decode(parts[1], validate=True)
    length = struct.unpack(">I", raw[:4])[0]
    assert raw[4:4 + length].decode("ascii") == parts[0]
except (AssertionError, ValueError, UnicodeError, struct.error):
    sys.exit("not a valid single-line public key")
'
fi

install -m 0755 "$HERE/homenet-pve-agent" /usr/local/bin/homenet-pve-agent
install -m 0644 "$HERE/homenet-pve-agent.service" /etc/systemd/system/homenet-pve-agent.service
systemctl daemon-reload
systemctl enable homenet-pve-agent.service >/dev/null
systemctl restart homenet-pve-agent.service

if [ -n "$KEY" ]; then
  umask 077
  mkdir -p /root/.ssh
  AUTH=/root/.ssh/authorized_keys
  [ -L "$AUTH" ] && AUTH="$(readlink -f "$AUTH")"   # Proxmox links it to /etc/pve/priv
  BODY="$(printf '%s\n' "$KEY" | awk '{print $2}')"
  LINE="restrict,command=\"/usr/local/bin/homenet-pve-agent serve$FLAGS\" $KEY"
  if [ -f "$AUTH" ]; then
    awk -v keybody="$BODY" '{ for (i=1; i<=NF; i++) if ($i == keybody) next; print }' "$AUTH" > "$AUTH.homenet.tmp"
    cat "$AUTH.homenet.tmp" > "$AUTH"
    rm -f "$AUTH.homenet.tmp"
  fi
  printf '%s\n' "$LINE" >> "$AUTH"
fi

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [ -s /run/homenet-pve/current.json ] && break
  sleep 1
done
/usr/local/bin/homenet-pve-agent serve ping
