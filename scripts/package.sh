#!/usr/bin/env bash
# Builds release archives for install.sh (NPM-40): one per router architecture,
# plus SHA256SUMS. Used by .github/workflows/release.yml and runnable locally.
#
#   scripts/package.sh [version] [arch...]     arch: arm64 armv7 mipsel mips
#
# The frontend must be built already (frontend/static/react/index.html).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:-$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)}"
shift || true
archs=("$@")
[ ${#archs[@]} -gt 0 ] || archs=(arm64 armv7 mipsel mips)
out="$root/dist"

[ -f "$root/frontend/static/react/index.html" ] || { echo "frontend is not built: frontend/static/react/index.html" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out"

for arch in "${archs[@]}"; do
  case "$arch" in
    arm64) env_go=(GOARCH=arm64) ;;
    armv7) env_go=(GOARCH=arm GOARM=7) ;;
    mipsel) env_go=(GOARCH=mipsle GOMIPS=softfloat) ;;
    mips) env_go=(GOARCH=mips GOMIPS=softfloat) ;;
    *) echo "unknown arch: $arch" >&2; exit 1 ;;
  esac
  stage="$out/stage-$arch/homenet"
  mkdir -p "$stage/bin" "$stage/config" "$stage/init.d" "$stage/netfilter.d"
  for pair in manager:manager nginx:nginx ctl:homenet gateway:gateway; do
    (cd "$root/backend" && env CGO_ENABLED=0 GOOS=linux "${env_go[@]}" go build -trimpath -ldflags "-s -w" -o "$stage/bin/${pair#*:}" "./${pair%%:*}")
  done
  cp -R "$root/frontend/static" "$stage/static"
  cp "$root"/init.d/* "$stage/init.d/"
  cp "$root"/netfilter.d/*.sh "$stage/netfilter.d/"
  cp "$root/config/nginx.conf" "$root/config/runtime.env.example" "$stage/config/"
  cp "$root/routes.defaults.yml" "$stage/"
  printf '%s\n' "$version" > "$stage/VERSION"
  printf '%s\n' "$arch" > "$stage/ARCH"
  tar -C "$out/stage-$arch" -czf "$out/homenet-linux-$arch.tar.gz" homenet
  rm -rf "$out/stage-$arch"
  echo "built dist/homenet-linux-$arch.tar.gz"
done

cp "$root/install.sh" "$out/install.sh"
(cd "$out" && sha256sum homenet-linux-*.tar.gz install.sh > SHA256SUMS)
echo "version $version"
