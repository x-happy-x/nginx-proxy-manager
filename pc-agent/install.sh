#!/bin/sh
# Install as the account HomeNet will use over SSH (no daemon or root needed).
set -eu
HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
KEY="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
BINARY="$HERE/homenet-pc-agent"
FLAGS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-docker-actions) FLAGS="$FLAGS --allow-docker-actions" ;;
    --allow-docker-logs) FLAGS="$FLAGS --allow-docker-logs" ;;
    --binary) shift; BINARY="${1:?missing binary path}" ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$KEY" ] || { echo 'usage: sh install.sh PUBLIC_KEY [--allow-docker-actions] [--allow-docker-logs] [--binary FILE]' >&2; exit 1; }
[ -f "$BINARY" ] || { echo "binary missing: $BINARY" >&2; exit 1; }
# The restricted command quotes this path literally. Reject characters that
# would break either the authorized_keys option or the shell quoting.
case "$HOME" in *\'*|*\"*|*\\*|*'
'*) echo 'unsupported home directory characters' >&2; exit 1 ;; esac
CR="$(printf '\r')"
case "$KEY" in *'
'*|*"$CR"*) echo 'public key must be one line' >&2; exit 1 ;; esac
umask 077
CHECK="$(mktemp)"
trap 'rm -f "$CHECK"' EXIT HUP INT TERM
printf '%s\n' "$KEY" > "$CHECK"
ssh-keygen -l -f "$CHECK" >/dev/null || { echo 'invalid public key' >&2; exit 1; }
TYPE="$(printf '%s\n' "$KEY" | awk '{print $1}')"
case "$TYPE" in ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) ;; *) echo 'plain OpenSSH public key required' >&2; exit 1 ;; esac
BODY="$(printf '%s\n' "$KEY" | awk '{print $2}')"
TARGET="$HOME/.local/bin/homenet-pc-agent"
mkdir -p "$HOME/.local/bin" "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
install -m 0755 "$BINARY" "$TARGET"
AUTH="$HOME/.ssh/authorized_keys"
touch "$AUTH"
chmod 600 "$AUTH"
awk -v keybody="$BODY" '{ for (i=1; i<=NF; i++) if ($i == keybody) next; print }' "$AUTH" > "$CHECK"
cat "$CHECK" > "$AUTH"
printf "restrict,command=\"'%s' serve%s\" %s\n" "$TARGET" "$FLAGS" "$KEY" >> "$AUTH"
"$TARGET" serve ping
