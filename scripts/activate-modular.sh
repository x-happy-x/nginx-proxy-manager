#!/bin/sh
# Run only as an explicitly requested deployment, after staging and migrate.
# nginx/mihomo/Account/DMS and all persistent data stay in place.
set -eu
RELEASE="${1:-}"
MODE="${2:---dry-run}"
CONFIG="${HOMENET_CORE_CONFIG:-/opt/etc/homenet/core/config.json}"
CURRENT="${HOMENET_CORE_CURRENT:-/opt/share/homenet/core/current}"
CORE_INIT="${HOMENET_CORE_INIT:-/opt/etc/init.d/S99homenet-core}"
LEGACY_INIT="${HOMENET_LEGACY_INIT:-/opt/etc/init.d/S99nginx-manager-lite}"
SAVED_LEGACY="$(dirname "$LEGACY_INIT")/.homenet-disabled-$(basename "$LEGACY_INIT")"
case "$RELEASE" in /*) ;; *) echo "Usage: $0 /absolute/core/release --dry-run|--apply" >&2; exit 2 ;; esac
case "$MODE" in --dry-run|--apply|--rollback) ;; *) exit 2 ;; esac
if [ "$MODE" = --rollback ]; then
 [ -e "$SAVED_LEGACY" ] || [ -L "$SAVED_LEGACY" ] || { echo "No saved legacy service" >&2; exit 1; }
 [ ! -e "$LEGACY_INIT" ] && [ ! -L "$LEGACY_INIT" ] || { echo "Both legacy paths exist; inspect before recovery" >&2; exit 1; }
 if [ -e "$CORE_INIT" ] || [ -L "$CORE_INIT" ]; then
  [ "$(readlink "$CORE_INIT")" = "$RELEASE/S99homenet-core" ] || exit 1
  HOMENET_CORE_CONFIG="$CONFIG" HOMENET_CORE_ROOT="$CURRENT" "$CORE_INIT" stop
  rm "$CORE_INIT"
 fi
 if [ -L "$CURRENT" ]; then [ "$(readlink "$CURRENT")" = "$RELEASE" ] || exit 1; rm "$CURRENT"; fi
 mv "$SAVED_LEGACY" "$LEGACY_INIT"
 "$LEGACY_INIT" start
 echo "Legacy service restored with current persistent data"
 exit 0
fi
[ -x "$RELEASE/core" ] && [ -x "$RELEASE/platformctl" ] && [ -f "$RELEASE/S99homenet-core" ]
[ -f "$CONFIG" ] && [ -e "$LEGACY_INIT" ]
[ ! -e "$SAVED_LEGACY" ] || { echo "Existing cutover journal requires recovery" >&2; exit 1; }
[ ! -e "$CORE_INIT" ] && [ ! -L "$CORE_INIT" ] || { echo "Core is already registered; use a Core update operation" >&2; exit 1; }
[ ! -e "$CURRENT" ] && [ ! -L "$CURRENT" ] || { echo "Core current pointer already exists" >&2; exit 1; }
command -v curl >/dev/null
"$RELEASE/platformctl" verify-migration --config "$CONFIG"
URL="$("$RELEASE/platformctl" ready-url --config "$CONFIG")"
printf 'Legacy: %s\nCore: %s\nConfiguration: %s\nReadiness: %s\n' "$LEGACY_INIT" "$RELEASE" "$CONFIG" "$URL"
[ "$MODE" = --apply ] || exit 0

CORE_STARTED=0
LEGACY_STOPPED=0
rollback() {
 trap - EXIT HUP INT TERM
 if [ "$CORE_STARTED" = 1 ]; then
  if ! "$CORE_INIT" stop; then echo "Core did not stop; refusing to start a second writer. Recover manually." >&2; exit 1; fi
 fi
 [ ! -L "$CORE_INIT" ] || rm "$CORE_INIT"
 [ ! -L "$CURRENT" ] || rm "$CURRENT"
 if [ -e "$SAVED_LEGACY" ] || [ -L "$SAVED_LEGACY" ]; then mv "$SAVED_LEGACY" "$LEGACY_INIT"; fi
 if [ "$LEGACY_STOPPED" = 1 ]; then "$LEGACY_INIT" start || { echo "Legacy restart failed" >&2; exit 1; }; fi
 echo "Cutover failed; legacy service restored, persistent data preserved" >&2
 exit 1
}
trap rollback EXIT HUP INT TERM
"$LEGACY_INIT" stop
LEGACY_STOPPED=1
"$RELEASE/platformctl" verify-migration --config "$CONFIG"
mv "$LEGACY_INIT" "$SAVED_LEGACY"
ln -s "$RELEASE" "$CURRENT"
ln -s "$RELEASE/S99homenet-core" "$CORE_INIT"
export HOMENET_CORE_CONFIG="$CONFIG"
export HOMENET_CORE_ROOT="$CURRENT"
CORE_STARTED=1
"$CORE_INIT" start
ATTEMPT=0
while ! curl --silent --fail --max-time 12 "$URL" >/dev/null; do
 ATTEMPT=$((ATTEMPT+1))
 [ "$ATTEMPT" -lt 10 ] || exit 1
 sleep 2
done
trap - EXIT HUP INT TERM
echo "Core and integration workers are ready. Legacy autostart is preserved in $SAVED_LEGACY."
