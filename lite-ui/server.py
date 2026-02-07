#!/usr/bin/env python3
import json
import mimetypes
import os
import subprocess
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import yaml


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

ROUTES_PATH = os.environ.get("ROUTES_PATH", "/opt/etc/homenet-nginx/routes.yml")
GEN_ROUTES_PATH = os.environ.get("GEN_ROUTES_PATH", "/opt/etc/homenet-nginx/gen_routes.py")
PYTHON_BIN = os.environ.get("PYTHON_BIN", "python3")
NGINX_CONF_ROOT = os.environ.get("NGINX_CONF_ROOT", "/etc/nginx")
NGINX_LISTEN_IPS = os.environ.get("NGINX_LISTEN_IPS", "")
LOCAL_CA_CERT = os.environ.get("LOCAL_CA_CERT", os.path.join(NGINX_CONF_ROOT, "local-ca", "ca.crt"))
LOCAL_CA_KEY = os.environ.get("LOCAL_CA_KEY", os.path.join(NGINX_CONF_ROOT, "local-ca", "ca.key"))
NDMC_BIN = os.environ.get("NDMC_BIN", "ndmc")
IP_HOST_DELETE_MODE = os.environ.get("IP_HOST_DELETE_MODE", "no-host")


def read_routes():
    if not os.path.exists(ROUTES_PATH):
        return {
            "email": "",
            "services": [],
            "ssl_mode": "acme",
            "listen_ips": [],
            "stub": {"enabled": True, "root": "/opt/var/www/stub"},
        }
    with open(ROUTES_PATH, "r") as f:
        data = yaml.safe_load(f) or {}
    return {
        "email": data.get("email", ""),
        "services": data.get("services", []),
        "ssl_mode": data.get("ssl_mode", "acme"),
        "listen_ips": data.get("listen_ips", []),
        "stub": data.get("stub", {"enabled": True, "root": "/opt/var/www/stub"}),
    }


def write_routes(data):
    payload = {
        "email": data.get("email", ""),
        "services": data.get("services", []),
        "ssl_mode": data.get("ssl_mode", "acme"),
        "listen_ips": data.get("listen_ips", []),
        "stub": data.get("stub", {"enabled": True, "root": "/opt/var/www/stub"}),
    }
    with open(ROUTES_PATH, "w") as f:
        yaml.safe_dump(
            payload,
            f,
            sort_keys=False,
            default_flow_style=False,
            allow_unicode=False,
        )


def apply_routes():
    cmd = [PYTHON_BIN, GEN_ROUTES_PATH, "--config", ROUTES_PATH]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return res.returncode == 0, res.stdout


def sync_local_dns(routes):
    services = routes.get("services", [])
    listen_ips = parse_listen_ips(routes.get("listen_ips", NGINX_LISTEN_IPS))
    dns_ip = listen_ips[0] if listen_ips else ""
    errors = []
    for svc in services:
        if not svc.get("add_to_local_dns"):
            continue
        upstream = svc.get("upstream", {})
        address = (upstream.get("address") or "").strip()
        if not address and not dns_ip:
            continue
        target_ip = dns_ip or address
        for host in svc.get("hosts", []):
            delete_ip_host(host, target_ip)
            ok, out = add_ip_host(host, target_ip)
            if not ok:
                errors.append(f"{host}: {out}")
    if errors:
        return False, "\n".join(errors)
    return True, "local DNS synced"


def parse_listen_ips(value):
    if not value:
        return []
    if isinstance(value, list):
        return [v.strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value).split(",") if v.strip()]


def listen_lines(port, listen_ips, extra=""):
    if not listen_ips:
        return [f"listen {port}{extra};"]
    return [f"listen {ip}:{port}{extra};" for ip in listen_ips]


def ensure_stub_cert(cert_dir):
    crt = os.path.join(cert_dir, "stub.crt")
    key = os.path.join(cert_dir, "stub.key")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    os.makedirs(cert_dir, exist_ok=True)
    subprocess.run(
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
            "/CN=stub",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    return crt, key


def apply_stub_config(routes):
    stub = routes.get("stub", {})
    if not stub.get("enabled", True):
        return True, "stub disabled"
    listen_ips = routes.get("listen_ips", NGINX_LISTEN_IPS)
    listen_ips = parse_listen_ips(listen_ips)
    stub_root = stub.get("root", "/opt/var/www/stub")
    cert_dir = os.path.join(NGINX_CONF_ROOT, "selfsigned")
    crt, key = ensure_stub_cert(cert_dir)
    listens_80 = "\n".join(listen_lines(80, listen_ips, " default_server"))
    listens_443 = "\n".join(listen_lines(443, listen_ips, " ssl default_server"))
    content = f"""server {{
{listens_80}
    server_name _;
    root {stub_root};
    index index.html;
    access_log /opt/var/log/nginx/stub_access.log;
    error_log  /opt/var/log/nginx/stub_error.log;
    location / {{
        try_files $uri $uri/ =404;
    }}
}}

server {{
{listens_443}
    server_name _;
    ssl_certificate {crt};
    ssl_certificate_key {key};
    root {stub_root};
    index index.html;
    access_log /opt/var/log/nginx/stub_access.log;
    error_log  /opt/var/log/nginx/stub_error.log;
    location / {{
        try_files $uri $uri/ =404;
    }}
}}
"""
    conf_dir = os.path.join(NGINX_CONF_ROOT, "conf.d")
    os.makedirs(conf_dir, exist_ok=True)
    with open(os.path.join(conf_dir, "stub.conf"), "w") as f:
        f.write(content)
    return True, "stub applied"


def save_stub_content(content):
    routes = read_routes()
    stub = routes.get("stub", {})
    stub_root = stub.get("root", "/opt/var/www/stub")
    os.makedirs(stub_root, exist_ok=True)
    path = os.path.join(stub_root, "index.html")
    with open(path, "w") as f:
        f.write(content)
    return True, f"stub saved to {path}"


def save_local_ca(cert_pem, key_pem):
    os.makedirs(os.path.dirname(LOCAL_CA_CERT), exist_ok=True)
    with open(LOCAL_CA_CERT, "w") as f:
        f.write(cert_pem)
    with open(LOCAL_CA_KEY, "w") as f:
        f.write(key_pem)
    return True, "local CA saved"


def has_local_ca():
    return os.path.exists(LOCAL_CA_CERT) and os.path.exists(LOCAL_CA_KEY)


def san_entry(value):
    v = value.strip()
    if not v:
        return ""
    if v.startswith("DNS:") or v.startswith("IP:"):
        return v
    if all(c.isdigit() or c == "." for c in v):
        return f"IP:{v}"
    return f"DNS:{v}"


def ensure_local_ca_signed(host, sans=None, force=False):
    cert_dir = os.path.join(NGINX_CONF_ROOT, "selfsigned")
    crt = os.path.join(cert_dir, f"{host}.crt")
    key = os.path.join(cert_dir, f"{host}.key")
    if os.path.exists(crt) and os.path.exists(key) and not force:
        return True, "exists"
    if force:
        try:
            os.remove(crt)
            os.remove(key)
        except OSError:
            pass
    if not has_local_ca():
        return False, "local CA not found"
    os.makedirs(cert_dir, exist_ok=True)
    csr = f"/tmp/{host}.csr"
    ext = f"/tmp/{host}.ext"
    with open(ext, "w") as f:
        alt_names = [san_entry(host)]
        for item in sans or []:
            ent = san_entry(item)
            if ent:
                alt_names.append(ent)
        alt_names = ",".join(sorted(set(alt_names)))
        f.write(f"subjectAltName={alt_names}\n")
    subprocess.run(
        ["openssl","req","-new","-newkey","rsa:2048","-nodes",
         "-keyout", key, "-out", csr, "-subj", f"/CN={host}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    subprocess.run(
        ["openssl","x509","-req","-in", csr,
         "-CA", LOCAL_CA_CERT, "-CAkey", LOCAL_CA_KEY, "-CAcreateserial",
         "-out", crt, "-days", "825", "-sha256", "-extfile", ext],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    return True, "issued"


def issue_local_ca_for_routes(force=False):
    routes = read_routes()
    services = routes.get("services", [])
    errors = []
    for svc in services:
        extra_sans = svc.get("san", [])
        for host in svc.get("hosts", []):
            ok, msg = ensure_local_ca_signed(host, sans=extra_sans, force=force)
            if not ok:
                errors.append(f"{host}: {msg}")
    if errors:
        return False, "\n".join(errors)
    return True, "issued"


def generate_local_ca(subject):
    os.makedirs(os.path.dirname(LOCAL_CA_CERT), exist_ok=True)
    subj = f"/C={subject.get('C','')}/ST={subject.get('ST','')}/L={subject.get('L','')}/O={subject.get('O','')}/CN={subject.get('CN','Local CA')}"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-new",
            "-nodes",
            "-keyout",
            LOCAL_CA_KEY,
            "-out",
            LOCAL_CA_CERT,
            "-sha256",
            "-days",
            "3650",
            "-subj",
            subj,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    return True, "local CA generated"


def send_pem(handler, path, filename):
    if not os.path.exists(path):
        handler.send_error(404, "Not found")
        return
    with open(path, "rb") as f:
        body = f.read()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-pem-file")
    handler.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def list_local_certs():
    cert_dir = os.path.join(NGINX_CONF_ROOT, "selfsigned")
    if not os.path.isdir(cert_dir):
        return []
    items = []
    for name in os.listdir(cert_dir):
        if not name.endswith(".crt"):
            continue
        host = name[:-4]
        crt = os.path.join(cert_dir, f"{host}.crt")
        key = os.path.join(cert_dir, f"{host}.key")
        items.append({"host": host, "has_key": os.path.exists(key), "path": crt})
    return sorted(items, key=lambda x: x["host"])


def delete_local_cert(host):
    cert_dir = os.path.join(NGINX_CONF_ROOT, "selfsigned")
    crt = os.path.join(cert_dir, f"{host}.crt")
    key = os.path.join(cert_dir, f"{host}.key")
    removed = False
    for path in (crt, key):
        if os.path.exists(path):
            os.remove(path)
            removed = True
    return removed


def test_certificate(host, port):
    cmd = [
        "sh",
        "-c",
        f'echo | openssl s_client -connect {host}:{port} -servername {host} 2>/dev/null | openssl x509 -noout -issuer -subject -text',
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return res.returncode == 0, res.stdout


def read_log_file(path, limit=200, contains=""):
    if not os.path.exists(path):
        return False, f"missing log: {path}", []
    lines = deque(maxlen=limit)
    with open(path, "r", errors="replace") as f:
        for line in f:
            if contains and contains not in line:
                continue
            lines.append(line.rstrip("\n"))
    return True, "", list(lines)


def nginx_status():
    status = {
        "running": False,
        "pid": "",
        "pids": [],
        "version": "",
        "config_files": [],
        "listeners": [],
        "rss_kb": 0,
    }
    try:
        res = subprocess.run(["pidof", "nginx"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        pids = [p for p in res.stdout.strip().split() if p.isdigit()]
    except FileNotFoundError:
        pids = []
    if pids:
        status["running"] = True
        status["pid"] = pids[0]
        status["pids"] = pids
        total_rss = 0
        for pid in pids:
            try:
                statm = f"/proc/{pid}/statm"
                with open(statm, "r") as f:
                    parts = f.read().split()
                if len(parts) > 1:
                    pages = int(parts[1])
                    total_rss += pages * (os.sysconf("SC_PAGE_SIZE") // 1024)
            except OSError:
                continue
        status["rss_kb"] = total_rss
    try:
        res = subprocess.run(["nginx", "-v"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        status["version"] = res.stdout.strip()
    except FileNotFoundError:
        status["version"] = "nginx not found"
    try:
        res = subprocess.run(["nginx", "-T"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        files = []
        for line in res.stdout.splitlines():
            if line.startswith("# configuration file "):
                path = line[len("# configuration file "):].strip()
                if path.endswith(":"):
                    path = path[:-1]
                files.append(path)
        status["config_files"] = sorted(set(files))
    except FileNotFoundError:
        pass
    try:
        res = subprocess.run(["ss", "-lntp"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        listeners = []
        for line in res.stdout.splitlines():
            if "nginx" not in line:
                continue
            if pids:
                if not any(f"pid={pid}" in line for pid in pids):
                    continue
            listeners.append(line)
        status["listeners"] = listeners
    except FileNotFoundError:
        try:
            res = subprocess.run(["netstat", "-lntp"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            listeners = []
            for line in res.stdout.splitlines():
                if "nginx" not in line:
                    continue
                if pids:
                    if not any(f"/{pid}" in line for pid in pids):
                        continue
                listeners.append(line)
            status["listeners"] = listeners
        except FileNotFoundError:
            pass
    return status


def run_ndmc(args):
    cmd = [NDMC_BIN, "-c", args]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return res.returncode == 0, res.stdout


def list_ip_hosts():
    ok, out = run_ndmc("show dns-proxy")
    if not ok:
        return False, out, []
    items = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("static_a = "):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        host = parts[2]
        addr = parts[3]
        items.append({"host": host, "address": addr})
    # de-dup while keeping order
    seen = set()
    uniq = []
    for it in items:
        key = (it["host"], it["address"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    return True, "", uniq


def add_ip_host(host, address):
    return run_ndmc(f"ip host {host} {address}")


def delete_ip_host(host, address):
    if IP_HOST_DELETE_MODE == "no-host":
        return run_ndmc(f"no ip host {host}")
    if IP_HOST_DELETE_MODE == "no-host-ip":
        return run_ndmc(f"no ip host {host} {address}")
    return False, f"unknown delete mode: {IP_HOST_DELETE_MODE}"


class Handler(BaseHTTPRequestHandler):
    server_version = "lite-nginx-manager/0.1"

    def log_message(self, fmt, *args):
        # Keep logs minimal to avoid noisy router syslog.
        return

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        params = dict([p.split("=", 1) for p in parsed.query.split("&") if "=" in p])
        if parsed.path == "/api/routes":
            self.send_json(200, read_routes())
            return
        if parsed.path == "/api/ca/status":
            self.send_json(200, {"ok": True, "installed": has_local_ca()})
            return
        if parsed.path == "/api/cert/list":
            self.send_json(200, {"ok": True, "items": list_local_certs()})
            return
        if parsed.path == "/api/nginx/logs":
            log_type = params.get("type", "access")
            contains = params.get("filter", "")
            try:
                limit = int(params.get("limit", "200"))
            except ValueError:
                limit = 200
            log_file = "/opt/var/log/nginx/access.log" if log_type == "access" else "/opt/var/log/nginx/error.log"
            ok, err, lines = read_log_file(log_file, limit=limit, contains=contains)
            if not ok:
                self.send_json(500, {"ok": False, "error": err})
                return
            self.send_json(200, {"ok": True, "lines": lines})
            return
        if parsed.path == "/api/nginx/status":
            self.send_json(200, {"ok": True, "status": nginx_status()})
            return
        if parsed.path == "/api/ca/download":
            send_pem(self, LOCAL_CA_CERT, "local-ca.crt")
            return
        if parsed.path == "/api/cert/download":
            params = dict([p.split("=", 1) for p in parsed.query.split("&") if "=" in p])
            host = params.get("host", "")
            kind = params.get("kind", "crt")
            if not host:
                self.send_error(400, "host required")
                return
            cert_dir = os.path.join(NGINX_CONF_ROOT, "selfsigned")
            if kind == "key":
                path = os.path.join(cert_dir, f"{host}.key")
                send_pem(self, path, f"{host}.key")
            else:
                path = os.path.join(cert_dir, f"{host}.crt")
                send_pem(self, path, f"{host}.crt")
            return
        if parsed.path == "/api/ip-hosts":
            ok, err, items = list_ip_hosts()
            if not ok:
                self.send_json(500, {"ok": False, "error": err})
                return
            self.send_json(200, {"ok": True, "items": items})
            return
        if parsed.path == "/":
            self.serve_static("index.html")
            return
        if parsed.path.startswith("/static/"):
            self.serve_static(parsed.path[len("/static/"):])
            return
        self.send_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/routes":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            write_routes(payload)
            self.send_json(200, {"ok": True})
            return
        if parsed.path == "/api/apply":
            ok, output = apply_routes()
            if ok:
                routes = read_routes()
                dns_ok, dns_out = sync_local_dns(routes)
                output = (output or "").rstrip()
                if dns_out:
                    output = (output + "\n" if output else "") + dns_out
                ok = ok and dns_ok
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/stub/apply":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            ok, output = apply_stub_config(payload)
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/stub/upload":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            content = payload.get("content", "")
            if not content:
                self.send_json(400, {"ok": False, "error": "empty_content"})
                return
            ok, output = save_stub_content(content)
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/ca/upload":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            cert_pem = payload.get("cert_pem", "")
            key_pem = payload.get("key_pem", "")
            if "BEGIN CERTIFICATE" not in cert_pem or "BEGIN" not in key_pem:
                self.send_json(400, {"ok": False, "error": "invalid_pem"})
                return
            ok, output = save_local_ca(cert_pem, key_pem)
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/ca/generate":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            ok, output = generate_local_ca(payload.get("subject", {}))
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/cert/test":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            host = (payload.get("host") or "").strip()
            port = int(payload.get("port") or 443)
            if not host:
                self.send_json(400, {"ok": False, "error": "host_required"})
                return
            ok, output = test_certificate(host, port)
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path == "/api/cert/delete":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            host = (payload.get("host") or "").strip()
            if not host:
                self.send_json(400, {"ok": False, "error": "host_required"})
                return
            ok = delete_local_cert(host)
            self.send_json(200, {"ok": ok, "output": "deleted" if ok else "not_found"})
            return
        if parsed.path == "/api/ca/issue":
            params = dict([p.split("=", 1) for p in parsed.query.split("&") if "=" in p])
            force = params.get("force", "0") in ("1", "true", "yes")
            ok, output = issue_local_ca_for_routes(force=force)
            self.send_json(200, {"ok": ok, "output": output})
            return
        if parsed.path in ("/api/ip-hosts/add", "/api/ip-hosts/delete"):
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw or "{}")
            except json.JSONDecodeError:
                self.send_json(400, {"ok": False, "error": "invalid_json"})
                return
            host = (payload.get("host") or "").strip()
            address = (payload.get("address") or "").strip()
            if not host or not address:
                self.send_json(400, {"ok": False, "error": "host_address_required"})
                return
            if parsed.path.endswith("/add"):
                ok, out = add_ip_host(host, address)
            else:
                ok, out = delete_ip_host(host, address)
            self.send_json(200, {"ok": ok, "output": out})
            return
        self.send_error(404, "Not found")

    def serve_static(self, rel_path):
        rel_path = rel_path.lstrip("/")
        if ".." in rel_path or rel_path.startswith("."):
            self.send_error(400, "Bad path")
            return
        path = os.path.join(STATIC_DIR, rel_path)
        if not os.path.isfile(path):
            self.send_error(404, "Not found")
            return
        ctype, _ = mimetypes.guess_type(path)
        ctype = ctype or "application/octet-stream"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    host = os.environ.get("LITE_UI_HOST", "0.0.0.0")
    port = int(os.environ.get("LITE_UI_PORT", "8080"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
