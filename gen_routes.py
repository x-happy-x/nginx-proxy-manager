#!/usr/bin/env python3
import os, sys, yaml, shutil, subprocess, pathlib, textwrap, shlex

CONF_ROOT = os.environ.get("NGINX_CONF_ROOT", "/etc/nginx")
NGINX_LISTEN_IPS = os.environ.get("NGINX_LISTEN_IPS", "")
LOCAL_CA_CERT = os.environ.get("LOCAL_CA_CERT", f"{CONF_ROOT}/local-ca/ca.crt")
LOCAL_CA_KEY = os.environ.get("LOCAL_CA_KEY", f"{CONF_ROOT}/local-ca/ca.key")
LE_ROOT = os.environ.get("LE_ROOT", "/etc/letsencrypt")
ACME_SH_CMD = os.environ.get("ACME_SH_CMD", "")
ACME_SH_HOME = os.environ.get("ACME_SH_HOME", "")
ACME_SH_SHELL = os.environ.get("ACME_SH_SHELL", "sh")
SITES_AVAIL = f"{CONF_ROOT}/sites-available"
SITES_ENABLED = f"{CONF_ROOT}/sites-enabled"
MANAGED_DIR = f"{SITES_AVAIL}/managed-crubs"
ACME_WEBROOT = "/var/www/_letsencrypt"
SELF_DIR = f"{CONF_ROOT}/selfsigned"
MAPS_CONF = f"{CONF_ROOT}/conf.d/crubs_maps.conf"
PROXY_SNIPPET = f"{CONF_ROOT}/snippets/crubs_proxy_common.conf"
ROUTE_ACCESS_LOG = os.environ.get("ROUTE_ACCESS_LOG", "/opt/var/log/nginx/route_access.log")

def sh(cmd, check=True):
    print("+", " ".join(cmd))
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if check and res.returncode != 0:
        print(res.stdout)
        sys.exit(res.returncode)
    return res.stdout

def write(path, content, mode=0o644):
    pathlib.Path(os.path.dirname(path)).mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    os.chmod(path, mode)

def ensure_common_snippets():
    # map для websocket
    if not os.path.exists(MAPS_CONF):
        write(MAPS_CONF, textwrap.dedent("""
# managed by crubs-nginx-yaml
map $http_upgrade $connection_upgrade {
default upgrade;
''      close;
}
              """).lstrip())

    # общий proxy набор
    if not os.path.exists(PROXY_SNIPPET):
        write(PROXY_SNIPPET, textwrap.dedent("""
# managed by crubs-nginx-yaml
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_read_timeout 3600;
proxy_send_timeout 3600;
proxy_buffering off;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
              """).lstrip())

    os.makedirs(ACME_WEBROOT, exist_ok=True)
    os.makedirs(SELF_DIR, exist_ok=True)

def is_public(host):
    return not host.endswith(".lan")

def le_paths(host):
    base = f"{LE_ROOT}/live/{host}"
    return base + "/fullchain.pem", base + "/privkey.pem"

def cert_exists(host):
    full, key = le_paths(host)
    return os.path.exists(full) and os.path.exists(key)

def self_paths(host):
    crt = f"{SELF_DIR}/{host}.crt"
    key = f"{SELF_DIR}/{host}.key"
    return crt, key

def ensure_selfsigned(host):
    crt, key = self_paths(host)
    if os.path.exists(crt) and os.path.exists(key):
        return
    subj = f"/CN={host}"
    sh(["openssl","req","-x509","-nodes","-newkey","rsa:2048",
        "-keyout", key, "-out", crt, "-days","365","-subj", subj])


def ensure_local_ca_signed(host):
    crt, key = self_paths(host)
    if os.path.exists(crt) and os.path.exists(key):
        return
    if not (os.path.exists(LOCAL_CA_CERT) and os.path.exists(LOCAL_CA_KEY)):
        print("Local CA not found, fallback to self-signed.")
        ensure_selfsigned(host)
        return
    os.makedirs(SELF_DIR, exist_ok=True)
    csr = f"/tmp/{host}.csr"
    ext = f"/tmp/{host}.ext"
    subj = f"/CN={host}"
    with open(ext, "w") as f:
        f.write(f"subjectAltName=DNS:{host}\n")
    sh(["openssl","req","-new","-newkey","rsa:2048","-nodes",
        "-keyout", key, "-out", csr, "-subj", subj])
    sh(["openssl","x509","-req","-in", csr,
        "-CA", LOCAL_CA_CERT, "-CAkey", LOCAL_CA_KEY, "-CAcreateserial",
        "-out", crt, "-days", "825", "-sha256", "-extfile", ext])

def enable_site(conf_path):
    name = os.path.basename(conf_path)
    link = os.path.join(SITES_ENABLED, name)
    os.makedirs(SITES_ENABLED, exist_ok=True)
    if os.path.islink(link) or os.path.exists(link):
        os.unlink(link)
    os.symlink(conf_path, link)

def clean_managed():
    # удалить старые symlink’и на managed-crubs
    if os.path.isdir(SITES_ENABLED):
        for f in os.listdir(SITES_ENABLED):
            p = os.path.join(SITES_ENABLED, f)
            try:
                tgt = os.readlink(p)
            except OSError:
                continue
            if "/managed-crubs/" in tgt:
                os.unlink(p)
    # пересоздать managed-каталог
    os.makedirs(SITES_AVAIL, exist_ok=True)
    os.makedirs(SITES_ENABLED, exist_ok=True)
    if os.path.exists(MANAGED_DIR):
        shutil.rmtree(MANAGED_DIR)
    os.makedirs(MANAGED_DIR, exist_ok=True)

def parse_listen_ips(value):
    if not value:
        return []
    if isinstance(value, list):
        return [v.strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value).split(",") if v.strip()]

def normalize_port(value, fallback):
    try:
        port = int(value)
    except (TypeError, ValueError):
        return fallback
    if 1 <= port <= 65535:
        return port
    return fallback

def normalize_port_list(value):
    out = []
    if not value:
        return out
    if not isinstance(value, list):
        value = [value]
    for item in value:
        p = normalize_port(item, 0)
        if p and p not in out:
            out.append(p)
    return out

def listen_lines(port, listen_ips, extra=""):
    if not listen_ips:
        return f"listen {port}{extra};"
    lines = [f"listen {ip}:{port}{extra};" for ip in listen_ips]
    return "\n".join(lines)

def server80(host, proxy_block, redirect_to_https, listen_ips, route_log_format, http_ports, https_port, extra_locations=""):
    acme = textwrap.dedent(f"""
location ^~ /.well-known/acme-challenge/ {{
                           root {ACME_WEBROOT};
default_type "text/plain";
}}
                           """).rstrip()
    body = acme + "\n\n"
    if extra_locations:
        body += extra_locations.rstrip() + "\n\n"
    if redirect_to_https:
        if int(https_port) == 443:
            body += "return 308 https://$host$request_uri;\n"
        else:
            body += f"return 308 https://$host:{https_port}$request_uri;\n"
    else:
        body += proxy_block + "\n"
    listens = "\n".join(listen_lines(p, listen_ips) for p in http_ports)
    return textwrap.dedent(f"""
server {{
{listens}
                           server_name {host};
                           access_log {ROUTE_ACCESS_LOG} {route_log_format};
                           {body}
}}
                           """).strip()

def server443(host, ssl_cert, ssl_key, proxy_block, listen_ips, route_log_format, https_ports, extra_locations=""):
    listens = "\n".join(listen_lines(p, listen_ips, " ssl") for p in https_ports)
    return textwrap.dedent(f"""
server {{
{listens}
                           server_name {host};
                           http2 on;
                           access_log {ROUTE_ACCESS_LOG} {route_log_format};
                           ssl_certificate {ssl_cert};
                           ssl_certificate_key {ssl_key};
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

                           {extra_locations}
                           {proxy_block}
}}
                           """).strip()

def proxy_block(up):
    scheme = str(up.get("scheme", "http")).strip().lower()
    addr = up["address"]
    port = up.get("port", 80)
    if scheme == "auto":
        proxy_scheme = "$scheme"
    elif scheme in ("http", "https"):
        proxy_scheme = scheme
    else:
        proxy_scheme = "http"
    lines = [f"location / {{",
             f"    proxy_pass {proxy_scheme}://{addr}:{port};",
             f"    include {PROXY_SNIPPET};"]
    if proxy_scheme in ("https", "$scheme"):
        # часто upstream=IP: self-signed → не проверяем
        if up.get("verify_upstream_ssl", False) is False:
            lines += ["    proxy_ssl_verify off;"]
        lines += ["    proxy_ssl_server_name on;"]
    lines += ["}"]
    return "\n".join(lines)


def ws_proxy_block(up, ws_cfg):
    if not isinstance(ws_cfg, dict):
        return ""
    if not ws_cfg.get("enabled", False):
        return ""
    path = str(ws_cfg.get("path", "/connections")).strip() or "/connections"
    if not path.startswith("/"):
        path = "/" + path

    scheme = str(up.get("scheme", "http")).strip().lower()
    addr = up["address"]
    port = up.get("port", 80)
    if scheme == "auto":
        proxy_scheme = "$scheme"
    elif scheme in ("http", "https"):
        proxy_scheme = scheme
    else:
        proxy_scheme = "http"

    lines = [f"location ^~ {path} {{",
             f"    proxy_pass {proxy_scheme}://{addr}:{port};",
             f"    include {PROXY_SNIPPET};"]
    if proxy_scheme in ("https", "$scheme"):
        if up.get("verify_upstream_ssl", False) is False:
            lines += ["    proxy_ssl_verify off;"]
        lines += ["    proxy_ssl_server_name on;"]
    lines += ["}"]
    return "\n".join(lines)


def ws_rewrite_lines(up, ws_cfg):
    if not isinstance(ws_cfg, dict):
        return []
    if not ws_cfg.get("enabled", False):
        return []
    if not ws_cfg.get("rewrite_to_wss", False):
        return []
    addr = str(up.get("address", "")).strip()
    port = str(up.get("port", "80")).strip()
    if not addr:
        return []
    ws_from = str(ws_cfg.get("rewrite_from", f"ws://{addr}:{port}")).strip()
    if not ws_from:
        return []
    return [
        "    sub_filter_once off;",
        "    sub_filter_types text/html text/plain application/javascript text/javascript;",
        f"    sub_filter '{ws_from}' 'wss://$host';",
    ]


def ndns_listener_block(svc, listen_ips):
    ndns_cfg = svc.get("ndns", {}) if isinstance(svc, dict) else {}
    if not isinstance(ndns_cfg, dict) or not ndns_cfg.get("enabled"):
        return None
    port = normalize_port(ndns_cfg.get("port"), 0)
    if not port:
        return None
    up = svc.get("upstream", {})
    if not up or not up.get("address"):
        return None

    ws_cfg = svc.get("ws_proxy", {})
    pb = proxy_block(up)
    wsb = ws_proxy_block(up, ws_cfg)
    rewrites = ws_rewrite_lines(up, ws_cfg)
    if rewrites:
        pb = pb.replace(f"    include {PROXY_SNIPPET};", f"    include {PROXY_SNIPPET};\n" + "\n".join(rewrites), 1)

    base_name = str(ndns_cfg.get("name") or "").strip()
    if not base_name:
        hosts = svc.get("hosts", [])
        if hosts:
            base_name = str(hosts[0]).split(".", 1)[0]
    if not base_name:
        base_name = "service"
    route_fmt = route_log_format_name(f"ndns_{base_name}")
    fmt_decl = textwrap.dedent(f"""
log_format {route_fmt} escape=json
  '{{"time":"$time_iso8601","remote":"$remote_addr","host":"$host","server_name":"$server_name","server_addr":"$server_addr","server_port":"$server_port","scheme":"$scheme","method":"$request_method","uri":"$request_uri","status":"$status","bytes_sent":"$body_bytes_sent","request_time":"$request_time","upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","proxy_host":"$proxy_host","http_referer":"$http_referer","http_user_agent":"$http_user_agent"}}';
""").strip()
    listens = listen_lines(port, listen_ips)
    conf = textwrap.dedent(f"""
server {{
{listens}
                           server_name _;
                           access_log {ROUTE_ACCESS_LOG} {route_fmt};
                           {wsb}
                           {pb}
}}
""").strip()
    safe_name = "".join(c if (c.isalnum() or c in ("-", "_")) else "_" for c in base_name)
    filename = f"ndns-port-{safe_name}-{port}.conf"
    return filename, fmt_decl + "\n\n" + conf + "\n"


def route_log_format_name(host):
    cleaned = "".join(c if (c.isalnum() or c == "_") else "_" for c in host)
    return f"crubs_route_{cleaned}"


def write_site(host, up, have_ssl, is_lan, ssl_mode, listen_ips, http_ports, https_ports, ws_cfg=None):
    pb = proxy_block(up)
    wsb = ws_proxy_block(up, ws_cfg)
    rewrites = ws_rewrite_lines(up, ws_cfg)
    if rewrites:
        pb = pb.replace(f"    include {PROXY_SNIPPET};", f"    include {PROXY_SNIPPET};\n" + "\n".join(rewrites), 1)
    route_fmt = route_log_format_name(host)
    fmt_decl = textwrap.dedent(f"""
log_format {route_fmt} escape=json
  '{{"time":"$time_iso8601","remote":"$remote_addr","host":"$host","server_name":"$server_name","server_addr":"$server_addr","server_port":"$server_port","scheme":"$scheme","method":"$request_method","uri":"$request_uri","status":"$status","bytes_sent":"$body_bytes_sent","request_time":"$request_time","upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","proxy_host":"$proxy_host","http_referer":"$http_referer","http_user_agent":"$http_user_agent"}}';
""").strip()
    https_port = https_ports[0]
    conf = []
    if ssl_mode == "off":
        conf.append(server80(host, pb, redirect_to_https=False, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
    elif ssl_mode == "self-signed":
        crt, key = self_paths(host)
        ensure_selfsigned(host)
        conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
        conf.append(server443(host, crt, key, pb, listen_ips=listen_ips, route_log_format=route_fmt, https_ports=https_ports, extra_locations=wsb))
    elif ssl_mode == "local-ca":
        crt, key = self_paths(host)
        ensure_local_ca_signed(host)
        conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
        conf.append(server443(host, crt, key, pb, listen_ips=listen_ips, route_log_format=route_fmt, https_ports=https_ports, extra_locations=wsb))
    else:
        if is_lan:
            # .lan: всегда https (self-signed), а 80 → редирект
            crt, key = self_paths(host)
            ensure_selfsigned(host)
            conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
            conf.append(server443(host, crt, key, pb, listen_ips=listen_ips, route_log_format=route_fmt, https_ports=https_ports, extra_locations=wsb))
        else:
            # публичный: если есть LE — редирект и полноценный 443, иначе — временно проксируем на 80
            if have_ssl:
                full, key = le_paths(host)
                conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
                conf.append(server443(host, full, key, pb, listen_ips=listen_ips, route_log_format=route_fmt, https_ports=https_ports, extra_locations=wsb))
            else:
                conf.append(server80(host, pb, redirect_to_https=False, listen_ips=listen_ips, route_log_format=route_fmt, http_ports=http_ports, https_port=https_port, extra_locations=wsb))
    return fmt_decl + "\n\n" + "\n\n".join(conf) + "\n"

def effective_ssl_mode(default_mode, svc, host):
    mode = default_mode
    if isinstance(svc, dict):
        mode = svc.get("ssl_mode", mode)
        host_modes = svc.get("host_ssl_mode", {})
        if isinstance(host_modes, dict):
            mode = host_modes.get(host, mode)
    mode = str(mode or default_mode).strip().lower()
    if mode not in ("acme", "local-ca", "self-signed", "off"):
        return default_mode
    return mode


def write_service_confs(svc, phase, default_ssl_mode, listen_ips, http_ports, https_ports):
    up = svc["upstream"]
    ws_cfg = svc.get("ws_proxy", {})
    for host in svc["hosts"]:
        public = is_public(host)
        have_ssl = cert_exists(host) if public else True
        ssl_mode = effective_ssl_mode(default_ssl_mode, svc, host)
        content = write_site(
            host,
            up,
            have_ssl,
            is_lan=not public,
            ssl_mode=ssl_mode,
            listen_ips=listen_ips,
            http_ports=http_ports,
            https_ports=https_ports,
            ws_cfg=ws_cfg,
        )
        path = f"{MANAGED_DIR}/{host}.conf"
        write(path, "# managed by crubs-nginx-yaml\n" + content)
        enable_site(path)
    ndns_conf = ndns_listener_block(svc, listen_ips)
    if ndns_conf:
        filename, content = ndns_conf
        path = f"{MANAGED_DIR}/{filename}"
        write(path, "# managed by crubs-nginx-yaml\n" + content)
        enable_site(path)


def validate_ndns_ports(services):
    used = {}
    errors = []
    for svc in services:
        ndns_cfg = svc.get("ndns", {}) if isinstance(svc, dict) else {}
        if not isinstance(ndns_cfg, dict) or not ndns_cfg.get("enabled"):
            continue
        port = normalize_port(ndns_cfg.get("port"), 0)
        if not port:
            continue
        hosts = svc.get("hosts", [])
        name = str(ndns_cfg.get("name") or "").strip()
        ident = name or (hosts[0] if hosts else f"service:{port}")
        if port in used:
            errors.append(f"Duplicate NDNS port {port}: {used[port]} and {ident}")
        else:
            used[port] = ident
    return errors

def nginx_reload():
    test_cmd = os.environ.get("NGINX_TEST_CMD", "nginx -t")
    reload_cmd = os.environ.get("NGINX_RELOAD_CMD", "systemctl reload nginx")
    sh(shlex.split(test_cmd))
    sh(shlex.split(reload_cmd))

def issue_missing_le(all_hosts, email, ssl_mode):
    if ssl_mode != "acme":
        return
    to_issue = [h for h in all_hosts if is_public(h) and not cert_exists(h)]
    if not to_issue: return
    if not email:
        print("LE email is empty, skip issuing certs.")
        return
    for host in to_issue:
        if ACME_SH_CMD:
            cmd = shlex.split(ACME_SH_CMD)
            if ACME_SH_SHELL and len(cmd) == 1:
                cmd = [ACME_SH_SHELL] + cmd
            if ACME_SH_HOME:
                cmd += ["--home", ACME_SH_HOME]
            sh(cmd + ["--issue","--webroot",ACME_WEBROOT,"-d",host,"--accountemail",email], check=False)
            full, key = le_paths(host)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            sh(cmd + ["--install-cert","-d",host,
                      "--fullchain-file", full,
                      "--key-file", key], check=False)
        else:
            sh(["certbot","certonly","--webroot","-w",ACME_WEBROOT,
                "-d",host,"-n","--agree-tos","-m",email,"--rsa-key-size","4096"], check=False)

def main():
    # Проверка root только на Unix
    if hasattr(os, 'geteuid') and os.geteuid() != 0:
        print("Запустите с sudo.")
        sys.exit(1)
    if len(sys.argv) < 3 or sys.argv[1] != "--config":
        print("Использование: sudo python3 gen_routes.py --config /routes.yml")
        sys.exit(1)

    with open(sys.argv[2]) as f:
        cfg = yaml.safe_load(f)

    ensure_common_snippets()
    clean_managed()

    services = cfg["services"]
    ndns_port_errors = validate_ndns_ports(services)
    if ndns_port_errors:
        print("NDNS port conflicts:")
        for err in ndns_port_errors:
            print("-", err)
        sys.exit(1)

    ssl_mode = cfg.get("ssl_mode", "acme")
    listen_ips = cfg.get("listen_ips", NGINX_LISTEN_IPS)
    listen_ips = parse_listen_ips(listen_ips)
    ports_cfg = cfg.get("ports", {})
    http_port = normalize_port(ports_cfg.get("http", 80), 80)
    https_port = normalize_port(ports_cfg.get("https", 443), 443)
    http_ports = [http_port] + [p for p in normalize_port_list(ports_cfg.get("http_extra", [])) if p != http_port]
    https_ports = [https_port] + [p for p in normalize_port_list(ports_cfg.get("https_extra", [])) if p != https_port]
    # Фаза 1: поднимаем :80 (и .lan с self-signed https)
    for svc in services:
        write_service_confs(
            svc,
            phase="bootstrap",
            default_ssl_mode=ssl_mode,
            listen_ips=listen_ips,
            http_ports=http_ports,
            https_ports=https_ports,
        )
    nginx_reload()

    # Выпускаем LE для публичных доменов без сертификата
    all_hosts = [h for s in services for h in s["hosts"]]
    issue_missing_le(all_hosts, cfg.get("email", ""), ssl_mode=ssl_mode)

    # Фаза 2: пересобираем уже с https для тех, кому выпустили
    clean_managed()
    for svc in services:
        write_service_confs(
            svc,
            phase="final",
            default_ssl_mode=ssl_mode,
            listen_ips=listen_ips,
            http_ports=http_ports,
            https_ports=https_ports,
        )
    nginx_reload()

if __name__ == "__main__":
    main()
