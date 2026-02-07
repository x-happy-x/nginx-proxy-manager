#!/bin/sh
set -eu

REPO_URL="https://github.com/x-happy-x/nginx-proxy-manager.git"
TARGET_DIR="/opt/etc/homenet-nginx"
INIT_UI_SRC="$TARGET_DIR/init.d/S99nginx-manager-lite"
INIT_UI_DST="/opt/etc/init.d/S99nginx-manager-lite"
INIT_IPS_SRC="$TARGET_DIR/init.d/S20-nginx-ips"
INIT_IPS_DST="/opt/etc/init.d/S20-nginx-ips"

if command -v opkg >/dev/null 2>&1; then
  opkg update || true
  opkg install nginx git python3 || true
fi

if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" pull --ff-only
else
  rm -rf "$TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
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
