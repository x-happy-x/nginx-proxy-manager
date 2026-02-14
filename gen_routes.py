#!/usr/bin/env python3
import argparse
import os
import pathlib
import shlex
import shutil
import subprocess
import textwrap

import yaml


CONF_ROOT = os.environ.get("NGINX_CONF_ROOT", "/etc/nginx")
NGINX_LISTEN_IPS = os.environ.get("NGINX_LISTEN_IPS", "")
LOCAL_CA_CERT = os.environ.get("LOCAL_CA_CERT", f"{CONF_ROOT}/local-ca/ca.crt")
LOCAL_CA_KEY = os.environ.get("LOCAL_CA_KEY", f"{CONF_ROOT}/local-ca/ca.key")
LE_ROOT = os.environ.get("LE_ROOT", "/etc/letsencrypt")
SITES_AVAIL = f"{CONF_ROOT}/sites-available"
SITES_ENABLED = f"{CONF_ROOT}/sites-enabled"
MANAGED_DIR = f"{SITES_AVAIL}/managed-homenet"
ACME_WEBROOT = "/var/www/_letsencrypt"
SELF_DIR = f"{CONF_ROOT}/selfsigned"
MAPS_CONF = f"{CONF_ROOT}/conf.d/homenet_maps.conf"
PROXY_SNIPPET = f"{CONF_ROOT}/snippets/homenet_proxy_common.conf"
ROUTE_ACCESS_LOG = os.environ.get("ROUTE_ACCESS_LOG", "/opt/var/log/nginx/route_access.log")


def sh(cmd, check=True):
    print("+", " ".join(cmd))
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if check and res.returncode != 0:
        print(res.stdout)
        raise SystemExit(res.returncode)
    return res.stdout


def write(path, content, mode=0o644):
    pathlib.Path(os.path.dirname(path)).mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(path, mode)


def normalize_port(value, fallback):
    try:
        port = int(value)
    except (TypeError, ValueError):
        return fallback
    if 1 <= port <= 65535:
        return port
    return fallback


def parse_listen_ips(value):
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value).split(",") if v.strip()]


def listen_lines(port, listen_ips, extra=""):
    if not listen_ips:
        return f"listen {port}{extra};"
    return "\n".join(f"listen {ip}:{port}{extra};" for ip in listen_ips)


def route_log_format_name(name):
    cleaned = "".join(c if (c.isalnum() or c == "_") else "_" for c in name)
    return f"homenet_route_{cleaned}"


def le_paths(host):
    base = f"{LE_ROOT}/live/{host}"
    return base + "/fullchain.pem", base + "/privkey.pem"


def self_paths(host):
    crt = f"{SELF_DIR}/{host}.crt"
    key = f"{SELF_DIR}/{host}.key"
    return crt, key


def ensure_selfsigned(host):
    crt, key = self_paths(host)
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    pathlib.Path(SELF_DIR).mkdir(parents=True, exist_ok=True)
    sh(
        [
            "openssl",
            "req",
            "-x509",
            "-nodes",
            "-newkey",
            "rsa:2048",
            "-keyout",
            key,
            "-out",
            crt,
            "-days",
            "365",
            "-subj",
            f"/CN={host}",
        ]
    )
    return crt, key


def ensure_local_ca_signed(host):
    crt, key = self_paths(host)
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    if not (os.path.exists(LOCAL_CA_CERT) and os.path.exists(LOCAL_CA_KEY)):
        return ensure_selfsigned(host)
    pathlib.Path(SELF_DIR).mkdir(parents=True, exist_ok=True)
    csr = f"/tmp/{host}.csr"
    ext = f"/tmp/{host}.ext"
    with open(ext, "w", encoding="utf-8") as f:
        f.write(f"subjectAltName=DNS:{host}\n")
    sh(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", f"/CN={host}"])
    sh(
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            csr,
            "-CA",
            LOCAL_CA_CERT,
            "-CAkey",
            LOCAL_CA_KEY,
            "-CAcreateserial",
            "-out",
            crt,
            "-days",
            "825",
            "-sha256",
            "-extfile",
            ext,
        ]
    )
    return crt, key


def resolve_cert_paths(host, host_cfg, cert_index):
    tls = host_cfg.get("tls", {}) or {}
    policy = str(tls.get("cert_policy", "auto_local_ca")).strip().lower()
    if policy == "off":
        return None, None, policy
    if policy == "self_signed":
        crt, key = ensure_selfsigned(host)
        return crt, key, policy
    if policy == "auto_local_ca":
        crt, key = ensure_local_ca_signed(host)
        return crt, key, policy
    if policy == "auto_acme":
        full, priv = le_paths(host)
        if os.path.exists(full) and os.path.exists(priv):
            return full, priv, policy
        # fallback to local-ca if LE cert is absent
        crt, key = ensure_local_ca_signed(host)
        return crt, key, "auto_local_ca"
    if policy == "custom_ref":
        ref = str(tls.get("cert_ref", "")).strip()
        item = cert_index.get(ref) or cert_index.get(host)
        if item:
            crt = item.get("crt_path")
            key = item.get("key_path")
            if crt and key and os.path.exists(crt) and os.path.exists(key):
                return crt, key, policy
        raise SystemExit(f"custom_ref certificate not found for host '{host}'")
    crt, key = ensure_local_ca_signed(host)
    return crt, key, "auto_local_ca"


def ensure_common_snippets():
    if not os.path.exists(MAPS_CONF):
        write(
            MAPS_CONF,
            textwrap.dedent(
                """
                # managed by homenet-nginx-yaml
                map $http_upgrade $connection_upgrade {
                  default upgrade;
                  ''      close;
                }
                """
            ).lstrip(),
        )
    if not os.path.exists(PROXY_SNIPPET):
        write(
            PROXY_SNIPPET,
            textwrap.dedent(
                """
                # managed by homenet-nginx-yaml
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
                """
            ).lstrip(),
        )
    os.makedirs(ACME_WEBROOT, exist_ok=True)
    os.makedirs(SELF_DIR, exist_ok=True)


def clean_managed():
    if os.path.isdir(SITES_ENABLED):
        for f in os.listdir(SITES_ENABLED):
            p = os.path.join(SITES_ENABLED, f)
            try:
                tgt = os.readlink(p)
            except OSError:
                continue
            if "/managed-homenet/" in tgt or "/managed-crubs-v2/" in tgt or "/managed-crubs/" in tgt:
                os.unlink(p)
        # remove old generated standalone files left from previous runs
        for f in os.listdir(SITES_ENABLED):
            p = os.path.join(SITES_ENABLED, f)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    head = fh.read(256)
            except OSError:
                continue
            if "managed by crubs-nginx-yaml" in head or "managed by homenet-nginx-yaml" in head:
                os.unlink(p)
    os.makedirs(SITES_AVAIL, exist_ok=True)
    os.makedirs(SITES_ENABLED, exist_ok=True)
    if os.path.exists(MANAGED_DIR):
        shutil.rmtree(MANAGED_DIR)
    # cleanup old legacy managed dirs
    for legacy in ("managed-crubs-v2", "managed-crubs"):
        legacy_dir = os.path.join(SITES_AVAIL, legacy)
        if os.path.isdir(legacy_dir):
            shutil.rmtree(legacy_dir)
    os.makedirs(MANAGED_DIR, exist_ok=True)


def enable_site(conf_path):
    name = os.path.basename(conf_path)
    link = os.path.join(SITES_ENABLED, name)
    if os.path.islink(link) or os.path.exists(link):
        os.unlink(link)
    os.symlink(conf_path, link)


def proxy_block(app):
    up = app.get("upstream", {}) or {}
    scheme = str(up.get("scheme", "http")).strip().lower()
    addr = up.get("address")
    port = up.get("port", 80)
    if not addr:
        raise SystemExit(f"upstream.address is required for app '{app.get('id', '?')}'")
    proxy_scheme = "https" if scheme == "https" else "http"
    lines = [
        "location / {",
        f"    proxy_pass {proxy_scheme}://{addr}:{port};",
        f"    include {PROXY_SNIPPET};",
    ]
    if proxy_scheme == "https":
        if up.get("verify_upstream_ssl", False) is False:
            lines.append("    proxy_ssl_verify off;")
        lines.append("    proxy_ssl_server_name on;")
    lines.append("}")
    return "\n".join(lines)


def ws_proxy_block(app):
    ws = app.get("ws_proxy", {}) or {}
    if not ws.get("enabled", False):
        return ""
    path = str(ws.get("path", "/connections")).strip() or "/connections"
    if not path.startswith("/"):
        path = "/" + path
    up = app.get("upstream", {}) or {}
    scheme = str(up.get("scheme", "http")).strip().lower()
    addr = up.get("address")
    port = up.get("port", 80)
    if not addr:
        return ""
    proxy_scheme = "https" if scheme == "https" else "http"
    lines = [
        f"location ^~ {path} {{",
        f"    proxy_pass {proxy_scheme}://{addr}:{port};",
        f"    include {PROXY_SNIPPET};",
    ]
    if proxy_scheme == "https":
        if up.get("verify_upstream_ssl", False) is False:
            lines.append("    proxy_ssl_verify off;")
        lines.append("    proxy_ssl_server_name on;")
    lines.append("}")
    return "\n".join(lines)


def ws_rewrite_lines(app):
    ws = app.get("ws_proxy", {}) or {}
    if not ws.get("enabled", False) or not ws.get("rewrite_to_wss", False):
        return []
    up = app.get("upstream", {}) or {}
    addr = str(up.get("address", "")).strip()
    port = str(up.get("port", "80")).strip()
    if not addr:
        return []
    ws_from = str(ws.get("rewrite_from", f"ws://{addr}:{port}")).strip()
    if not ws_from:
        return []
    return [
        "    sub_filter_once off;",
        "    sub_filter_types text/html text/plain application/javascript text/javascript;",
        f"    sub_filter '{ws_from}' 'wss://$host';",
    ]


def build_host_conf(host_cfg, app, global_http_port, listen_ips, cert_index):
    host = host_cfg.get("host")
    if not host:
        return ""
    endpoints = host_cfg.get("endpoints", []) or []
    web = None
    ndns_eps = []
    for ep in endpoints:
        if (ep.get("name") or "").strip().lower() == "web" and web is None:
            web = ep
        elif (ep.get("name") or "").strip().lower() == "ndns" or (ep.get("behavior") or {}).get("ndns_profile"):
            ndns_eps.append(ep)
    if web is None:
        return ""

    fmt_name = route_log_format_name(host)
    fmt_decl = textwrap.dedent(
        f"""
        log_format {fmt_name} escape=json
          '{{"time":"$time_iso8601","remote":"$remote_addr","host":"$host","server_name":"$server_name","server_addr":"$server_addr","server_port":"$server_port","scheme":"$scheme","method":"$request_method","uri":"$request_uri","status":"$status","bytes_sent":"$body_bytes_sent","request_time":"$request_time","upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","proxy_host":"$proxy_host","http_referer":"$http_referer","http_user_agent":"$http_user_agent"}}';
        """
    ).strip()

    pb = proxy_block(app)
    wsb = ws_proxy_block(app)
    rewrites = ws_rewrite_lines(app)
    if rewrites:
        pb = pb.replace(f"    include {PROXY_SNIPPET};", f"    include {PROXY_SNIPPET};\n" + "\n".join(rewrites), 1)

    listen = web.get("listen", {}) or {}
    behavior = web.get("behavior", {}) or {}
    web_proto = str(listen.get("protocol", "https")).strip().lower()
    web_port = normalize_port(listen.get("port"), 443 if web_proto == "https" else 80)
    redirect = str(behavior.get("redirect", "off")).strip().lower()

    blocks = [fmt_decl]

    if web_proto == "https":
        crt, key, _ = resolve_cert_paths(host, host_cfg, cert_index)
        https_block = textwrap.dedent(
            f"""
            server {{
              {listen_lines(web_port, listen_ips, " ssl")}
              server_name {host};
              http2 on;
              access_log {ROUTE_ACCESS_LOG} {fmt_name};
              ssl_certificate {crt};
              ssl_certificate_key {key};
              add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

              {wsb}
              {pb}
            }}
            """
        ).strip()
        blocks.append(https_block)

        if redirect == "https":
            target = "" if int(web_port) == 443 else f":{web_port}"
            http_redirect = textwrap.dedent(
                f"""
                server {{
                  {listen_lines(global_http_port, listen_ips)}
                  server_name {host};
                  access_log {ROUTE_ACCESS_LOG} {fmt_name};
                  location ^~ /.well-known/acme-challenge/ {{
                    root {ACME_WEBROOT};
                    default_type "text/plain";
                  }}
                  return 308 https://$host{target}$request_uri;
                }}
                """
            ).strip()
            blocks.append(http_redirect)
        elif redirect == "http":
            http_reverse = textwrap.dedent(
                f"""
                server {{
                  {listen_lines(global_http_port, listen_ips)}
                  server_name {host};
                  access_log {ROUTE_ACCESS_LOG} {fmt_name};
                  {wsb}
                  {pb}
                }}
                """
            ).strip()
            blocks.append(http_reverse)
    else:
        http_block = textwrap.dedent(
            f"""
            server {{
              {listen_lines(web_port, listen_ips)}
              server_name {host};
              access_log {ROUTE_ACCESS_LOG} {fmt_name};
              location ^~ /.well-known/acme-challenge/ {{
                root {ACME_WEBROOT};
                default_type "text/plain";
              }}
              {wsb}
              {pb}
            }}
            """
        ).strip()
        blocks.append(http_block)

    for idx, ep in enumerate(ndns_eps, start=1):
        ep_listen = ep.get("listen", {}) or {}
        ep_behavior = ep.get("behavior", {}) or {}
        ep_port = ep_listen.get("port")
        if isinstance(ep_port, str) and ep_port == "auto_random":
            raise SystemExit(f"host '{host}' endpoint '{ep.get('name', 'ndns')}' still has auto_random; resolve it before generation")
        ep_port = normalize_port(ep_port, 0)
        if not ep_port:
            continue
        ep_proto = str(ep_listen.get("protocol", "http")).strip().lower()
        ep_fmt = route_log_format_name(f"{host}_ndns_{idx}")
        ep_fmt_decl = textwrap.dedent(
            f"""
            log_format {ep_fmt} escape=json
              '{{"time":"$time_iso8601","remote":"$remote_addr","host":"$host","server_name":"$server_name","server_addr":"$server_addr","server_port":"$server_port","scheme":"$scheme","method":"$request_method","uri":"$request_uri","status":"$status","bytes_sent":"$body_bytes_sent","request_time":"$request_time","upstream_addr":"$upstream_addr","upstream_status":"$upstream_status","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","proxy_host":"$proxy_host","http_referer":"$http_referer","http_user_agent":"$http_user_agent"}}';
            """
        ).strip()
        blocks.append(ep_fmt_decl)
        ssl_extra = ""
        ssl_lines = ""
        if ep_proto == "https":
            crt, key, _ = resolve_cert_paths(host, host_cfg, cert_index)
            ssl_extra = " ssl"
            ssl_lines = f"\n  ssl_certificate {crt};\n  ssl_certificate_key {key};"
        ep_block = textwrap.dedent(
            f"""
            server {{
              {listen_lines(ep_port, listen_ips, ssl_extra)}
              server_name _;
              access_log {ROUTE_ACCESS_LOG} {ep_fmt};{ssl_lines}
              # ndns_profile: {ep_behavior.get("ndns_profile", "ndns_proxy")}
              {wsb}
              {pb}
            }}
            """
        ).strip()
        blocks.append(ep_block)

    return "\n\n".join(blocks) + "\n"


def allocate_auto_random_ports(hosts, reserved=None):
    used = set(reserved or [])
    for host_cfg in hosts:
        for ep in host_cfg.get("endpoints", []) or []:
            p = normalize_port((ep.get("listen", {}) or {}).get("port"), 0)
            if p:
                used.add(p)
    next_port = 20000
    for host_cfg in hosts:
        for ep in host_cfg.get("endpoints", []) or []:
            listen = ep.get("listen", {}) or {}
            if str(listen.get("port", "")).strip() != "auto_random":
                continue
            while next_port in used and next_port <= 59999:
                next_port += 1
            if next_port > 59999:
                raise SystemExit("No free port for auto_random in range 20000..59999")
            listen["port"] = next_port
            used.add(next_port)
            next_port += 1


def build_cert_index(cfg):
    index = {}
    for item in cfg.get("certs", []) or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id") or item.get("host") or "").strip()
        if key:
            index[key] = item
    return index


def nginx_reload():
    test_cmd = os.environ.get("NGINX_TEST_CMD", "nginx -t")
    reload_cmd = os.environ.get("NGINX_RELOAD_CMD", "systemctl reload nginx")
    sh(shlex.split(test_cmd))
    sh(shlex.split(reload_cmd))


def main():
    parser = argparse.ArgumentParser(description="Generate nginx config from routes schema v2.1")
    parser.add_argument("--config", required=True, help="Path to routes v2.1 YAML")
    parser.add_argument("--dry-run", action="store_true", help="Do not test/reload nginx")
    args = parser.parse_args()

    if hasattr(os, "geteuid") and os.geteuid() != 0:
        print("Run with sudo/root.")
        raise SystemExit(1)

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    if str(cfg.get("schema_version")) != "2.1":
        raise SystemExit("schema_version must be 2.1")

    globals_cfg = cfg.get("globals", {}) or {}
    ports_cfg = globals_cfg.get("ports", {}) or {}
    listen_ips = parse_listen_ips(globals_cfg.get("listen_ips", NGINX_LISTEN_IPS))
    global_http_port = normalize_port(ports_cfg.get("http", 80), 80)
    global_https_port = normalize_port(ports_cfg.get("https", 443), 443)
    reserved_ports = {global_http_port, global_https_port}
    for p in ports_cfg.get("http_extra", []) or []:
        p = normalize_port(p, 0)
        if p:
            reserved_ports.add(p)
    for p in ports_cfg.get("https_extra", []) or []:
        p = normalize_port(p, 0)
        if p:
            reserved_ports.add(p)

    apps = cfg.get("apps", []) or []
    hosts = cfg.get("hosts", []) or []
    app_index = {str(a.get("id")): a for a in apps if isinstance(a, dict) and a.get("id")}
    cert_index = build_cert_index(cfg)

    allocate_auto_random_ports(hosts, reserved=reserved_ports)
    ensure_common_snippets()
    clean_managed()

    for host_cfg in hosts:
        host = host_cfg.get("host")
        app_id = host_cfg.get("app_id")
        if not host or not app_id:
            continue
        app = app_index.get(app_id)
        if not app:
            raise SystemExit(f"Unknown app_id '{app_id}' for host '{host}'")
        content = build_host_conf(host_cfg, app, global_http_port, listen_ips, cert_index)
        if not content:
            continue
        fname = f"{host}.conf"
        path = f"{MANAGED_DIR}/{fname}"
        write(path, "# managed by homenet-nginx-yaml\n" + content)
        enable_site(path)

    if not args.dry_run:
        nginx_reload()
    else:
        print("Dry run complete. Config files generated, reload skipped.")


if __name__ == "__main__":
    main()
