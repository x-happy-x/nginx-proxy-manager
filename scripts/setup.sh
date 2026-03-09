#!/bin/sh
set -eu

REPO_URL="https://github.com/x-happy-x/nginx-proxy-manager.git"
TARGET_DIR="/opt/etc/homenet-nginx"
INIT_UI_SRC="$TARGET_DIR/init.d/S99nginx-manager-lite"
INIT_UI_DST="/opt/etc/init.d/S99nginx-manager-lite"
INIT_IPS_SRC="$TARGET_DIR/init.d/S20-nginx-ips"
INIT_IPS_DST="/opt/etc/init.d/S20-nginx-ips"
ENV_DST="$TARGET_DIR/config/runtime.env"
ENV_BACKUP=""

cleanup() {
  if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
    rm -f "$ENV_BACKUP"
  fi
}
trap cleanup EXIT

if command -v opkg >/dev/null 2>&1; then
  opkg update || true
  opkg install nginx git || true
fi

if [ -d "$TARGET_DIR/.git" ]; then
  if [ -f "$ENV_DST" ]; then
    ENV_BACKUP="$(mktemp)"
    cp "$ENV_DST" "$ENV_BACKUP"
    git -C "$TARGET_DIR" checkout -- config/runtime.env
  fi
  git -C "$TARGET_DIR" pull --ff-only
else
  rm -rf "$TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi

mkdir -p "$(dirname "$ENV_DST")"
if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$ENV_DST"
fi

if [ -f "$INIT_IPS_SRC" ]; then
  ln -sf "$INIT_IPS_SRC" "$INIT_IPS_DST"
  chmod +x "$INIT_IPS_SRC"
  if [ -x "$INIT_IPS_DST" ]; then
    "$INIT_IPS_DST" start || true
  fi
fi

if [ -f "$INIT_UI_SRC" ]; then
  ln -sf "$INIT_UI_SRC" "$INIT_UI_DST"
  chmod +x "$INIT_UI_SRC"
  if [ -x "$INIT_UI_DST" ]; then
    "$INIT_UI_DST" restart || "$INIT_UI_DST" start
  fi
fi

echo "OK: installed/updated at $TARGET_DIR"
