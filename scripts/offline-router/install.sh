#!/bin/sh
set -eu
BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m)" in aarch64|arm64) ;; *) echo 'Нужен роутер ARM64 с Entware в /opt.' >&2; exit 1;; esac
export HOMENET_RUNTIME="$BUNDLE/payload/opt/share/homenet/offline-runtime"
exec "$HOMENET_RUNTIME/bin/python3" "$BUNDLE/install.py" "$@"
