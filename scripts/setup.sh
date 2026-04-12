#!/bin/sh
set -eu

REPO_URL="https://github.com/x-happy-x/nginx-proxy-manager.git"
TARGET_DIR="/opt/etc/homenet/nginx"
LEGACY_TARGET_DIR="/opt/etc/homenet-nginx"
BIN_DIR="/opt/bin"
INIT_UI_SRC="$TARGET_DIR/init.d/S99nginx-manager-lite"
INIT_UI_DST="/opt/etc/init.d/S99nginx-manager-lite"
INIT_IPS_SRC="$TARGET_DIR/init.d/S20-nginx-ips"
INIT_IPS_DST="/opt/etc/init.d/S20-nginx-ips"
HOMENET_SRC="$TARGET_DIR/bin/linux-arm64/homenet"
HOMENET_DST="$BIN_DIR/homenet"
ENV_DST="$TARGET_DIR/config/runtime.env"
ENV_BACKUP=""

migrate_runtime_env_paths() {
  target="$1"
  [ -f "$target" ] || return 0
  sed -i "s#/opt/etc/homenet-nginx#/opt/etc/homenet/nginx#g" "$target"
}

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
  if [ ! -d "$TARGET_DIR" ] && [ -d "$LEGACY_TARGET_DIR" ]; then
    mkdir -p "$(dirname "$TARGET_DIR")"
    mv "$LEGACY_TARGET_DIR" "$TARGET_DIR"
  else
    rm -rf "$TARGET_DIR"
  fi
  git clone "$REPO_URL" "$TARGET_DIR"
fi

mkdir -p "$(dirname "$ENV_DST")"
if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$ENV_DST"
fi
migrate_runtime_env_paths "$ENV_DST"

if [ -x "$HOMENET_SRC" ] && [ -d "$BIN_DIR" ]; then
  cp -f "$HOMENET_SRC" "$HOMENET_DST"
  chmod 755 "$HOMENET_DST"
fi

if [ -f "$INIT_IPS_SRC" ]; then
  cp -f "$INIT_IPS_SRC" "$INIT_IPS_DST"
  chmod 755 "$INIT_IPS_DST"
  if [ -x "$INIT_IPS_DST" ]; then
    "$INIT_IPS_DST" start || true
  fi
fi

if [ -f "$INIT_UI_SRC" ]; then
  cp -f "$INIT_UI_SRC" "$INIT_UI_DST"
  chmod 755 "$INIT_UI_DST"
  if [ -x "$INIT_UI_DST" ]; then
    "$INIT_UI_DST" restart || "$INIT_UI_DST" start
  fi
fi

echo "OK: installed/updated at $TARGET_DIR"
