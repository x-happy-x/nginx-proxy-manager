#!/bin/sh
# HomeNet installer for Keenetic / Netcraze routers with Entware (NPM-40).
#
#   curl -fsSL https://raw.githubusercontent.com/x-happy-x/nginx-proxy-manager/master/install.sh | sh
#
# Detects the architecture, asks what to install — HomeNet (console and proxy),
# the XKeen and mihomo forks, the SMS gateway — installs the dependencies and
# the release for this router. Run it again to update: settings, routes and
# certificates stay. Options:
#
#   --yes                 take the defaults, ask nothing
#   --components=LIST     homenet,xkeen,sms (default: asked)
#   --version=TAG         release tag (default: latest)
#   --from-file=FILE      install HomeNet from a local archive (testing)
#   --ui-host=IP --ui-port=PORT --alias=DEV=IP/MASK --access=0|1
#   --dry-run             show what would be done
#   --uninstall           stop HomeNet and remove its init scripts (data stays)
#
# Nothing here asks for or stores your passwords: the SMS gateway asks for its
# RouterOS account itself, on this router.
set -eu

REPO="${HOMENET_REPO:-x-happy-x/nginx-proxy-manager}"
SMS_INSTALL="${SMS_INSTALL_URL:-https://raw.githubusercontent.com/x-happy-x/sms-gateway/master/install.sh}"
XKEEN_INSTALL="${XKEEN_INSTALL_URL:-https://raw.githubusercontent.com/x-happy-x/XKeen/main/install.sh}"
HOMENET_ROOT=/opt/etc/homenet
APP="$HOMENET_ROOT/nginx"
PROXY="$HOMENET_ROOT/proxy"
INITD=/opt/etc/init.d
HOOK_DIR=/opt/etc/ndm/netfilter.d

YES=0 DRY=0 UNINSTALL=0
COMPONENTS="" VERSION="" FROM_FILE=""
OPT_UI_HOST="" OPT_UI_PORT="" OPT_ALIAS="" OPT_ACCESS=""

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --components=*) COMPONENTS="${arg#*=}" ;;
    --version=*) VERSION="${arg#*=}" ;;
    --from-file=*) FROM_FILE="${arg#*=}" ;;
    --ui-host=*) OPT_UI_HOST="${arg#*=}" ;;
    --ui-port=*) OPT_UI_PORT="${arg#*=}" ;;
    --alias=*) OPT_ALIAS="${arg#*=}" ;;
    --access=*) OPT_ACCESS="${arg#*=}" ;;
    --help|-h) sed -n '2,22p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Неизвестный параметр: $arg (см. --help)" >&2; exit 2 ;;
  esac
done

# ---------- output ----------
if [ -t 1 ]; then B="$(printf '\033[1m')" G="$(printf '\033[32m')" Y="$(printf '\033[33m')" R="$(printf '\033[31m')" N="$(printf '\033[0m')"; else B="" G="" Y="" R="" N=""; fi
say() { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() { printf '%sОшибка:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# run CMD... — executes, or prints it with --dry-run
run() {
  if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

# Questions come from the terminal even when the script itself is piped to sh.
TTY=""
if [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi

# ask "question" default → answer on stdout
ask() {
  q="$1" def="$2"
  if [ "$YES" = 1 ] || [ -z "$TTY" ]; then printf '%s' "$def"; return; fi
  printf '%s%s%s [%s]: ' "$B" "$q" "$N" "$def" >"$TTY"
  IFS= read -r ans <"$TTY" || ans=""
  [ -n "$ans" ] && printf '%s' "$ans" || printf '%s' "$def"
}

# ask_yn "question" y|n → exit status 0 for yes
ask_yn() {
  def="$2"
  hint="y/N"; [ "$def" = y ] && hint="Y/n"
  if [ "$YES" = 1 ] || [ -z "$TTY" ]; then [ "$def" = y ]; return; fi
  while :; do
    printf '%s%s%s [%s]: ' "$B" "$1" "$N" "$hint" >"$TTY"
    IFS= read -r ans <"$TTY" || ans=""
    case "${ans:-$def}" in y|Y|yes|д|Д|да) return 0 ;; n|N|no|н|Н|нет) return 1 ;; esac
  done
}

has() { command -v "$1" >/dev/null 2>&1; }

# ---------- platform ----------
detect_arch() {
  m="$(uname -m 2>/dev/null || echo unknown)"
  case "$m" in
    aarch64|arm64) echo arm64 ;;
    armv7*|armv8l) echo armv7 ;;
    mips*)
      if opkg print-architecture 2>/dev/null | grep -q mipsel || [ "$m" = mipsel ]; then echo mipsel
      elif printf '\001\000' | od -An -tx2 2>/dev/null | grep -q 0001; then echo mipsel
      else echo mips; fi ;;
    *) echo "unknown:$m" ;;
  esac
}

ip_of() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{print $4}' | head -1; }

check_platform() {
  [ "$(id -u)" = 0 ] || die "запустите от root (SSH роутера)"
  [ -x /opt/bin/opkg ] || die "нужен Entware в /opt: установите его через веб-интерфейс роутера (OPKG)"
  ARCH="$(detect_arch)"
  case "$ARCH" in unknown:*) die "архитектура ${ARCH#unknown:} не поддерживается (нужны arm64, armv7, mipsel, mips)" ;; esac
  KEENETIC=0
  if has ndmc || [ -x /usr/sbin/ndmc ]; then KEENETIC=1; fi
  FIRMWARE_NGINX=0
  if [ -x /usr/sbin/nginx ]; then FIRMWARE_NGINX=1; fi
}

state() {
  HN_VERSION=""
  [ -f "$APP/VERSION" ] && HN_VERSION="$(cat "$APP/VERSION")"
  [ -z "$HN_VERSION" ] && [ -f "$APP/config/runtime.env" ] && HN_VERSION="установлен"
  XKEEN_STATE="нет"
  if [ -x /opt/sbin/xkeen ] || has xkeen; then
    XKEEN_STATE="есть"
    if grep -rqs "x-happy-x" /opt/sbin/.xkeen 2>/dev/null; then XKEEN_STATE="форк x-happy-x"; else XKEEN_STATE="оригинальный"; fi
  fi
  MIHOMO_STATE="нет"
  if [ -x /opt/sbin/mihomo ]; then
    MIHOMO_STATE="$(/opt/sbin/mihomo -v 2>/dev/null | head -1 | sed 's/^Mihomo Meta //' | cut -c1-40)"
    [ -n "$MIHOMO_STATE" ] || MIHOMO_STATE="есть"
  fi
  SMS_STATE="нет"
  if [ -f /opt/sms-gateway/server.py ]; then SMS_STATE="установлен"; fi
}

need_pkgs() {
  missing=""
  for p in "$@"; do
    case "$p" in
      curl) has curl || missing="$missing curl" ;;
      ca-bundle) [ -f /opt/etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-bundle" ;;
      tar) tar --help 2>&1 | grep -q -- '-z' || missing="$missing tar" ;;
      python3) has python3 || [ -x /opt/bin/python3 ] || missing="$missing python3" ;;
    esac
  done
  [ -z "$missing" ] && return 0
  step "Пакеты Entware:$missing"
  run opkg update
  # shellcheck disable=SC2086
  run opkg install $missing
}

sha_check() {
  file="$1" sums="$2" name="$3"
  # "hash  name" (Linux) or "hash *name" (binary mode)
  want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$sums")"
  [ -n "$want" ] || die "в SHA256SUMS нет $name"
  got="$(sha256sum "$file" | awk '{print $1}')"
  [ "$want" = "$got" ] || die "контрольная сумма $name не совпала: архив повреждён или подменён"
}

download() {
  url="$1" dest="$2"
  curl -fsSL --retry 3 --connect-timeout 15 -o "$dest" "$url" || die "не удалось скачать $url"
}

# ---------- HomeNet ----------
homenet_questions() {
  BR0="$(ip_of br0)"
  [ -n "$BR0" ] || BR0="192.168.1.1/24"
  ROUTER_IP="${BR0%/*}"
  ENV="$APP/config/runtime.env"
  if [ -f "$ENV" ]; then
    say "Настройки HomeNet уже есть ($ENV) — они сохранятся."
    UI_HOST="$(sed -n 's/^LITE_UI_HOST=//p' "$ENV" | head -1)"
    UI_PORT="$(sed -n 's/^LITE_UI_PORT=//p' "$ENV" | head -1)"
    return
  fi
  say ""
  say "${B}HomeNet${N}: консоль управления и отдельный прокси nginx рядом со штатным."
  UI_HOST="${OPT_UI_HOST:-$(ask "Адрес консоли (IP роутера)" "$ROUTER_IP")}"
  UI_PORT="${OPT_UI_PORT:-$(ask "Порт консоли" "63412")}"
  net="${ROUTER_IP%.*}"
  mask="${BR0#*/}"
  def_alias="br0=$net.2/$mask"
  say "Сайты прокси слушают свой адрес на br0, чтобы не мешать штатному веб-интерфейсу на 80/443."
  ALIAS="${OPT_ALIAS:-$(ask "Адрес прокси (устройство=IP/маска)" "$def_alias")}"
  alias_ip="${ALIAS#*=}"; alias_ip="${alias_ip%/*}"
  if [ "$DRY" = 0 ] && ping -c 1 -W 1 "$alias_ip" >/dev/null 2>&1 && ! ip -4 -o addr | grep -q " $alias_ip/"; then
    warn "$alias_ip уже отвечает в сети — выберите свободный адрес"
    ask_yn "Всё равно использовать $alias_ip?" n || die "выберите другой адрес: --alias=br0=IP/маска"
  fi
  if [ -n "$OPT_ACCESS" ]; then ACCESS="$OPT_ACCESS"
  elif ask_yn "Включить вход через единый аккаунт (нужен настроенный шлюз, docs/account-gateway.md)?" n; then ACCESS=1
  else ACCESS=0; fi
}

homenet_install() {
  [ "$FIRMWARE_NGINX" = 1 ] || die "нет штатного /usr/sbin/nginx: HomeNet рассчитан на Keenetic/Netcraze"
  [ "$KEENETIC" = 1 ] || warn "ndmc не найден: DNS и KeenDNS роутера HomeNet менять не сможет"
  need_pkgs curl ca-bundle tar
  homenet_questions

  tmp="$(mktemp -d /opt/tmp/homenet-install.XXXXXX 2>/dev/null || mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  archive="$tmp/homenet.tar.gz"
  if [ -n "$FROM_FILE" ]; then
    step "Архив HomeNet из $FROM_FILE"
    cp "$FROM_FILE" "$archive"
  else
    base="https://github.com/$REPO/releases/latest/download"
    [ -n "$VERSION" ] && base="https://github.com/$REPO/releases/download/$VERSION"
    step "Скачиваю HomeNet ${VERSION:-последний} для $ARCH"
    if [ "$DRY" = 1 ]; then say "   [dry-run] $base/homenet-linux-$ARCH.tar.gz"; else
      download "$base/homenet-linux-$ARCH.tar.gz" "$archive"
      download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
      sha_check "$archive" "$tmp/SHA256SUMS" "homenet-linux-$ARCH.tar.gz"
    fi
  fi
  if [ "$DRY" = 0 ]; then
    tar -xzf "$archive" -C "$tmp" || die "архив не распаковался"
    [ "$(cat "$tmp/homenet/ARCH")" = "$ARCH" ] || die "архив для $(cat "$tmp/homenet/ARCH"), а роутер $ARCH"
    NEW_VERSION="$(cat "$tmp/homenet/VERSION")"
  else
    NEW_VERSION="${VERSION:-latest}"
  fi
  src="$tmp/homenet"

  # Binaries: the folder an existing install uses (deploy-router.py keeps
  # bin/linux-arm64), else bin/linux-<arch>.
  BIN_DIR="$APP/bin/linux-$ARCH"
  if [ -f "$APP/config/runtime.env" ]; then
    named="$(sed -n 's/^HOME_NET_BIN_DIR=//p' "$APP/config/runtime.env" | head -1)"
    if [ -n "$named" ]; then BIN_DIR="$named"; elif [ -d "$APP/bin/linux-arm64" ]; then BIN_DIR="$APP/bin/linux-arm64"; fi
  fi

  if [ -n "$HN_VERSION" ]; then
    backup="$HOMENET_ROOT/backup-$(date +%Y%m%d-%H%M%S)"
    step "Копия текущей установки → $backup"
    run mkdir -p "$backup"
    [ -d "$BIN_DIR" ] && run cp -a "$BIN_DIR" "$backup/bin"
    [ -d "$APP/frontend/static" ] && run cp -a "$APP/frontend/static" "$backup/static"
    for f in S20-nginx-ips S98nginx-local-conf S99nginx-manager-lite S98homenet-gateway; do
      [ -f "$INITD/$f" ] && run cp -p "$INITD/$f" "$backup/"
    done
    [ -f "$APP/config/runtime.env" ] && run cp -p "$APP/config/runtime.env" "$backup/"
    [ -f "$INITD/S99nginx-manager-lite" ] && run sh "$INITD/S99nginx-manager-lite" stop || true
  fi

  step "Устанавливаю HomeNet $NEW_VERSION ($ARCH)"
  run mkdir -p "$BIN_DIR" "$APP/config" "$APP/frontend" "$PROXY/conf.d" "$PROXY/sites-enabled" "$PROXY/snippets" /opt/var/log/homenet /opt/var/www/stub /opt/var/run "$HOOK_DIR"
  for b in manager nginx homenet gateway; do run install_file "$src/bin/$b" "$BIN_DIR/$b" 755; done
  run rm -rf "$APP/frontend/static.new"
  run cp -a "$src/static" "$APP/frontend/static.new"
  run rm -rf "$APP/frontend/static"
  run mv "$APP/frontend/static.new" "$APP/frontend/static"
  run install_file "$src/routes.defaults.yml" "$APP/routes.defaults.yml" 644
  [ -f "$PROXY/nginx.conf" ] || run install_file "$src/config/nginx.conf" "$PROXY/nginx.conf" 644
  if [ ! -f "$APP/config/runtime.env" ]; then
    alias_ip="${ALIAS#*=}"; alias_ip="${alias_ip%/*}"
    run write_env "$src/config/runtime.env.example" "$APP/config/runtime.env"
  fi
  if [ ! -f "$APP/routes.yml" ]; then
    run write_file "$APP/routes.yml" 'schema_version: 2.1
apps: []
'
  fi
  for f in S20-nginx-ips S98nginx-local-conf S99nginx-manager-lite; do run install_file "$src/init.d/$f" "$INITD/$f" 755; done
  if grep -qs '^HOMENET_ACCESS_ENABLED=1' "$APP/config/runtime.env" || [ "${ACCESS:-0}" = 1 ]; then
    run install_file "$src/init.d/S98homenet-gateway" "$INITD/S98homenet-gateway" 755
  fi
  run install_file "$src/netfilter.d/60-homenet-tls-sni.sh" "$HOOK_DIR/60-homenet-tls-sni.sh" 755
  [ "$DRY" = 1 ] || printf '%s\n' "$NEW_VERSION" >"$APP/VERSION"
  [ -L /opt/bin/homenet ] || [ -e /opt/bin/homenet ] || run ln -s "$BIN_DIR/homenet" /opt/bin/homenet

  step "Запускаю"
  run sh "$INITD/S20-nginx-ips" start
  run sh "$INITD/S98nginx-local-conf" start
  [ -f "$INITD/S98homenet-gateway" ] && [ -f "$HOMENET_ROOT/gateway.json" ] && run sh "$INITD/S98homenet-gateway" restart || true
  run sh "$INITD/S99nginx-manager-lite" start
  if [ "$DRY" = 0 ]; then
    i=0
    until curl -fsS -o /dev/null --max-time 3 "http://$UI_HOST:$UI_PORT/" 2>/dev/null; do
      i=$((i + 1)); [ "$i" -ge 15 ] && die "консоль не ответила на http://$UI_HOST:$UI_PORT/ — смотрите /opt/var/log/nginx-manager-lite.log"
      sleep 1
    done
  fi
  if [ "$DRY" = 1 ]; then say "Консоль будет на http://$UI_HOST:$UI_PORT/"; else say "${G}HomeNet работает:${N} http://$UI_HOST:$UI_PORT/"; fi
  if grep -qs '^HOMENET_ACCESS_ENABLED=1' "$APP/config/runtime.env" && [ ! -f "$HOMENET_ROOT/gateway.json" ]; then
    warn "вход через аккаунт включён, но $HOMENET_ROOT/gateway.json нет — настройте шлюз (docs/account-gateway.md) или поставьте HOMENET_ACCESS_ENABLED=0"
  fi
}

install_file() { cp "$1" "$2.new" && chmod "$3" "$2.new" && mv "$2.new" "$2"; }
write_file() { printf '%s' "$2" >"$1.new" && mv "$1.new" "$1"; }
write_env() {
  sed -e "s|@BIN_DIR@|$BIN_DIR|g" -e "s|@LISTEN_IPS@|$alias_ip|g" -e "s|@ALIASES@|$ALIAS|g" \
      -e "s|@UI_HOST@|$UI_HOST|g" -e "s|@UI_PORT@|$UI_PORT|g" -e "s|@ACCESS@|${ACCESS:-0}|g" "$1" >"$2.new" &&
    chmod 600 "$2.new" && mv "$2.new" "$2"
}

homenet_uninstall() {
  step "Останавливаю HomeNet и убираю init-скрипты"
  for f in S99nginx-manager-lite S98nginx-local-conf S98homenet-gateway; do
    [ -f "$INITD/$f" ] && run sh "$INITD/$f" stop || true
  done
  [ -x "$HOOK_DIR/60-homenet-tls-sni.sh" ] && type=iptables table=mangle run sh "$HOOK_DIR/60-homenet-tls-sni.sh" remove || true
  for f in S20-nginx-ips S98nginx-local-conf S99nginx-manager-lite S98homenet-gateway; do run rm -f "$INITD/$f"; done
  run rm -f "$HOOK_DIR/60-homenet-tls-sni.sh" /opt/bin/homenet
  say "Данные остались в $HOMENET_ROOT (маршруты, сертификаты, настройки). Удалить полностью: rm -rf $HOMENET_ROOT"
  say "Адрес прокси на br0 пропадёт после перезагрузки роутера."
}

# ---------- XKeen and mihomo (forks) ----------
xkeen_install() {
  need_pkgs curl ca-bundle
  if [ -d /opt/etc/mihomo ]; then
    keep="/opt/etc/mihomo.bak-$(date +%Y%m%d-%H%M%S)"
    step "Копия настроек mihomo → $keep"
    run cp -a /opt/etc/mihomo "$keep"
  fi
  step "XKeen из форка x-happy-x (установщик задаёт свои вопросы)"
  if [ "$DRY" = 1 ]; then say "   [dry-run] sh <(curl $XKEEN_INSTALL) --stable"; return; fi
  [ -n "$TTY" ] || die "установщику XKeen нужен терминал: запустите в SSH"
  f="$(mktemp /opt/tmp/xkeen-install.XXXXXX 2>/dev/null || mktemp)"
  download "$XKEEN_INSTALL" "$f"
  sh "$f" --stable <"$TTY" || die "установщик XKeen завершился с ошибкой"
  rm -f "$f"
  if [ -x /opt/sbin/xkeen ] && ask_yn "Установить или обновить mihomo из форка x-happy-x/mihomo (xkeen -um)?" y; then
    /opt/sbin/xkeen -um <"$TTY" || warn "xkeen -um завершился с ошибкой"
  fi
  say "Если ядро ещё xray, переключите на mihomo: xkeen -mihomo"
}

# ---------- SMS gateway ----------
sms_install() {
  need_pkgs curl ca-bundle
  step "SMS-шлюз (его установщик спросит адрес RouterOS и учётную запись)"
  if [ "$DRY" = 1 ]; then say "   [dry-run] sh <(curl $SMS_INSTALL)"; return; fi
  f="$(mktemp /opt/tmp/sms-install.XXXXXX 2>/dev/null || mktemp)"
  download "$SMS_INSTALL" "$f"
  flags=""
  if [ "$YES" = 1 ] || [ -z "$TTY" ]; then flags="--yes"; fi
  if [ -n "$TTY" ]; then sh "$f" $flags <"$TTY" || die "установщик SMS-шлюза завершился с ошибкой"
  else sh "$f" $flags || die "установщик SMS-шлюза завершился с ошибкой"; fi
  rm -f "$f"
}

# ---------- main ----------
check_platform
state
say "${B}HomeNet — установка на роутер${N}"
say "  архитектура:  $ARCH$([ "$KEENETIC" = 1 ] && echo ', Keenetic/Netcraze')"
say "  HomeNet:      ${HN_VERSION:-нет}"
say "  XKeen:        $XKEEN_STATE"
say "  mihomo:       $MIHOMO_STATE"
say "  SMS-шлюз:     $SMS_STATE"
[ "$DRY" = 1 ] && say "  режим:        пробный (--dry-run), ничего не меняется"

if [ "$UNINSTALL" = 1 ]; then homenet_uninstall; exit 0; fi

if [ -z "$COMPONENTS" ]; then
  say ""
  want_hn=y; want_xk=n; want_sms=n
  case "$XKEEN_STATE" in нет|оригинальный) want_xk=y ;; esac
  ask_yn "HomeNet: консоль и прокси ${HN_VERSION:+(обновить)}" "$want_hn" && COMPONENTS="homenet"
  ask_yn "XKeen и mihomo из форков x-happy-x$( [ "$XKEEN_STATE" = оригинальный ] && echo ' (замена оригинального XKeen)')" "$want_xk" && COMPONENTS="$COMPONENTS,xkeen"
  ask_yn "SMS-шлюз (нужен MikroTik с LTE-модемом)" "$want_sms" && COMPONENTS="$COMPONENTS,sms"
fi
COMPONENTS=",$COMPONENTS,"
[ "$COMPONENTS" != ",," ] || { say "Ничего не выбрано."; exit 0; }

case "$COMPONENTS" in *,xkeen,*) xkeen_install ;; esac
case "$COMPONENTS" in *,homenet,*) homenet_install ;; esac
case "$COMPONENTS" in *,sms,*) sms_install ;; esac
step "Готово"
