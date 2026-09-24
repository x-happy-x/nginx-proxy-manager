#!/bin/sh
# Keenetic drops TLS to the router's own addresses on port 443 unless the SNI is one of
# the router's domains (mangle _NDM_HTTP_INPUT_TLS_). HomeNet's dedicated proxy aliases
# serve other names (xkeen.local, *.home.arpa, ...), so only those exact addresses skip
# that check; the router's own web interface stays behind the firmware filter.
# ndm runs this after every netfilter rebuild ($type, $table); S20-nginx-ips runs it at
# boot. "remove" deletes the rules.
[ "${type:-iptables}" = "iptables" ] || exit 0
[ "${table:-mangle}" = "mangle" ] || exit 0
APP_DIR="${HOME_NET_APP_DIR:-/opt/etc/homenet/nginx}"
[ -f "$APP_DIR/config/runtime.env" ] || exit 0
. "$APP_DIR/config/runtime.env"
TAG="homenet_tls_sni"
for ip in $(echo "${NGINX_LISTEN_IPS:-}" | tr ',' ' '); do
  case "$ip" in
    192.168.1.2|192.168.99.2) ;;
    *) echo "homenet: listener $ip is not an allowed proxy alias; TLS filter left unchanged" >&2; continue ;;
  esac
  rule="-d $ip/32 -p tcp --dport 443 -m comment --comment $TAG -j ACCEPT"
  if [ "${1:-}" = "remove" ]; then
    while iptables -t mangle -C INPUT $rule 2>/dev/null; do iptables -t mangle -D INPUT $rule; done
  else
    iptables -t mangle -C INPUT $rule 2>/dev/null || iptables -t mangle -I INPUT 1 $rule
  fi
done
exit 0
