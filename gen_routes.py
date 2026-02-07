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

def listen_lines(port, listen_ips, extra=""):
    if not listen_ips:
        return f"listen {port}{extra};"
    lines = [f"listen {ip}:{port}{extra};" for ip in listen_ips]
    return "\n".join(lines)

def server80(host, proxy_block, redirect_to_https, listen_ips):
    acme = textwrap.dedent(f"""
location ^~ /.well-known/acme-challenge/ {{
                           root {ACME_WEBROOT};
default_type "text/plain";
}}
                           """).rstrip()
    body = acme + "\n\n"
    if redirect_to_https:
        body += "return 308 https://$host$request_uri;\n"
    else:
        body += proxy_block + "\n"
    listens = listen_lines(80, listen_ips)
    return textwrap.dedent(f"""
server {{
{listens}
                           server_name {host};
                           {body}
}}
                           """).strip()

def server443(host, ssl_cert, ssl_key, proxy_block, listen_ips):
    listens = listen_lines(443, listen_ips, " ssl http2")
    return textwrap.dedent(f"""
server {{
{listens}
                           server_name {host};
                           ssl_certificate {ssl_cert};
                           ssl_certificate_key {ssl_key};
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

                           {proxy_block}
}}
                           """).strip()

def proxy_block(up):
    scheme = up.get("scheme","http")
    addr = up["address"]
    port = up.get("port", 80)
    lines = [f"location / {{",
             f"    proxy_pass {scheme}://{addr}:{port};",
             f"    include {PROXY_SNIPPET};"]
    if scheme == "https":
        # часто upstream=IP: self-signed → не проверяем
        if up.get("verify_upstream_ssl", False) is False:
            lines += ["    proxy_ssl_verify off;"]
        lines += ["    proxy_ssl_server_name on;"]
    lines += ["}"]
    return "\n".join(lines)

def write_site(host, up, have_ssl, is_lan, ssl_mode, listen_ips):
    pb = proxy_block(up)
    conf = []
    if ssl_mode == "off":
        conf.append(server80(host, pb, redirect_to_https=False, listen_ips=listen_ips))
    elif ssl_mode == "self-signed":
        crt, key = self_paths(host)
        ensure_selfsigned(host)
        conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips))
        conf.append(server443(host, crt, key, pb, listen_ips=listen_ips))
    elif ssl_mode == "local-ca":
        crt, key = self_paths(host)
        ensure_local_ca_signed(host)
        conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips))
        conf.append(server443(host, crt, key, pb, listen_ips=listen_ips))
    else:
        if is_lan:
            # .lan: всегда https (self-signed), а 80 → редирект
            crt, key = self_paths(host)
            ensure_selfsigned(host)
            conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips))
            conf.append(server443(host, crt, key, pb, listen_ips=listen_ips))
        else:
            # публичный: если есть LE — редирект и полноценный 443, иначе — временно проксируем на 80
            if have_ssl:
                full, key = le_paths(host)
                conf.append(server80(host, pb, redirect_to_https=True, listen_ips=listen_ips))
                conf.append(server443(host, full, key, pb, listen_ips=listen_ips))
            else:
                conf.append(server80(host, pb, redirect_to_https=False, listen_ips=listen_ips))
    return "\n\n".join(conf) + "\n"

def write_service_confs(svc, phase, ssl_mode, listen_ips):
    up = svc["upstream"]
    for host in svc["hosts"]:
        public = is_public(host)
        have_ssl = cert_exists(host) if public else True
        content = write_site(host, up, have_ssl, is_lan=not public, ssl_mode=ssl_mode, listen_ips=listen_ips)
        path = f"{MANAGED_DIR}/{host}.conf"
        write(path, "# managed by crubs-nginx-yaml\n" + content)
        enable_site(path)

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
    ssl_mode = cfg.get("ssl_mode", "acme")
    listen_ips = cfg.get("listen_ips", NGINX_LISTEN_IPS)
    listen_ips = parse_listen_ips(listen_ips)
    # Фаза 1: поднимаем :80 (и .lan с self-signed https)
    for svc in services:
        write_service_confs(svc, phase="bootstrap", ssl_mode=ssl_mode, listen_ips=listen_ips)
    nginx_reload()

    # Выпускаем LE для публичных доменов без сертификата
    all_hosts = [h for s in services for h in s["hosts"]]
    issue_missing_le(all_hosts, cfg.get("email", ""), ssl_mode=ssl_mode)

    # Фаза 2: пересобираем уже с https для тех, кому выпустили
    clean_managed()
    for svc in services:
        write_service_confs(svc, phase="final", ssl_mode=ssl_mode, listen_ips=listen_ips)
    nginx_reload()

if __name__ == "__main__":
    main()
