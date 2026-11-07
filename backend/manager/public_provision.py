"""Executed over pinned SSH by the Proxy worker, with a base64 JSON argument.

Only HomeNet-owned vhosts, tunnel keys and per-user sshd settings are replaced.
A durable before-image journal is recovered after a failed or interrupted setup.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import signal
import subprocess
import sys
import tempfile


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True, timeout=110)


def atomic(path, body, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".homenet-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def certificate(sid, host):
    return "/etc/letsencrypt/live/homenet-public-" + sid + "-" + host


def render(p, marker, require_tls=False):
    out = marker
    for f in p["forwards"]:
        host, port = f["host"], f["port"]
        http_port, https_port = f.get("http_port", 80), f.get("https_port", 443)
        authority = host if https_port == 443 else host + ":" + str(https_port)
        cert = certificate(p["id"], host)
        tls = Path(cert + "/fullchain.pem").exists() and Path(cert + "/privkey.pem").exists()
        if require_tls and not tls:
            raise RuntimeError("Certificate missing: " + host)
        listens = "\n".join(" listen " + str(n) + ";" for n in sorted({80, http_port}))
        out += "server {\n" + listens + "\n server_name " + host + ";\n location ^~ /.well-known/acme-challenge/ { root /var/lib/homenet-public/acme; }\n location / { return 308 https://" + authority + "$request_uri; }\n}\n"
        if tls:
            location = "return 403;" if f.get("disabled") else "proxy_pass http://127.0.0.1:" + str(port) + ";"
            out += "server {\n listen " + str(https_port) + " ssl;\n server_name " + host + ";\n ssl_certificate " + cert + "/fullchain.pem;\n ssl_certificate_key " + cert + "/privkey.pem;\n ssl_protocols TLSv1.2 TLSv1.3;\n client_max_body_size 0;\n location / {\n " + location + "\n proxy_http_version 1.1;\n proxy_set_header Host " + authority + ";\n proxy_set_header X-Forwarded-Proto https;\n proxy_set_header X-Forwarded-For $remote_addr;\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection \"upgrade\";\n proxy_read_timeout 3600s;\n proxy_buffering off;\n }\n}\n"
    return out


def check_domains(p, nginx, own_conf):
    foreign, current = [], ""
    for line in nginx.splitlines():
        if line.startswith("# configuration file "):
            current = line[len("# configuration file "):].rstrip(":")
        if current == str(own_conf):
            continue
        found = re.search(r"^\s*server_name\s+([^;]+);", line)
        if found:
            foreign.extend(found.group(1).split())
    expected = {i[4][0] for i in socket.getaddrinfo(p["address"], None, type=socket.SOCK_STREAM)}
    for f in p["forwards"]:
        host = f["host"]
        for name in foreign:
            if name == host or (name.startswith("*.") and host.endswith(name[1:])) or (name.startswith(".") and (host == name[1:] or host.endswith(name))) or name.startswith("~"):
                raise RuntimeError("Domain overlaps an existing nginx vhost: " + host)
        actual = {i[4][0] for i in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)}
        if not actual or not actual.issubset(expected):
            raise RuntimeError("DNS " + host + " must point only to this server: " + ", ".join(sorted(expected)))


def reload_ssh():
    run("/usr/sbin/sshd", "-t")
    try:
        run("systemctl", "reload", "ssh")
    except subprocess.CalledProcessError:
        run("systemctl", "reload", "sshd")


def configure(p):
    if os.geteuid() != 0:
        raise RuntimeError("SSH root required")
    sid = p["id"]
    user = "homenet-tunnel-" + sid
    marker = "# Managed by HomeNet public servers: " + sid + "\n"
    conf = Path("/etc/nginx/conf.d/homenet-public-" + sid + ".conf")
    sshd = Path("/etc/ssh/sshd_config.d/homenet-public-" + sid + ".conf")
    sshdir = Path("/home") / user / ".ssh"
    keys = sshdir / "authorized_keys"
    state = Path("/var/lib/homenet-public/servers") / sid
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    journal = state / "transaction.json"

    def recover():
        if not journal.exists():
            return
        before = json.loads(journal.read_text())
        for path in (conf, sshd, keys):
            body = before[str(path)]
            if body is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, body, 0o644 if path == conf else 0o600)
        if before["nginx"]:
            run("nginx", "-t")
            run("systemctl", "reload", "nginx")
        if before["ssh"]:
            reload_ssh()
        journal.unlink()

    recover()
    for path in (conf, sshd):
        if path.exists() and not path.read_text().startswith(marker):
            raise RuntimeError("Foreign file: " + str(path))
    if not p["forwards"] and not conf.exists() and not sshd.exists():
        print("Monitoring only; no public domains")
        return

    nginx = run("nginx", "-T")
    check_domains(p, nginx, conf)
    # Never point a newly published hostname at an unrelated loopback service.
    # Old SSH sessions are reaped by ClientAliveInterval/CountMax below; a
    # remaining listener is retried by the worker without changing nginx.
    for forward in p["forwards"]:
        if forward.get("disabled"):
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", forward["port"]))
            except OSError as exc:
                raise RuntimeError("Reverse port is occupied: " + str(forward["port"]) + "; waiting for the old SSH session to close") from exc
    if p["forwards"]:
        try:
            run("id", user)
        except subprocess.CalledProcessError:
            run("useradd", "--create-home", "--shell", "/usr/sbin/nologin", user)
            atomic(state / "user-owned", user)
        else:
            if not (state / "user-owned").exists():
                raise RuntimeError("Existing user is not owned by HomeNet: " + user)
        sshdir.mkdir(mode=0o700, parents=True, exist_ok=True)
        run("chown", user + ":" + user, str(sshdir))

    before = {str(path): path.read_text() if path.exists() else None for path in (conf, sshd, keys)}
    before.update(nginx=True, ssh=True)
    atomic(journal, json.dumps(before))
    def interrupted(signum, frame):
        raise RuntimeError("Publication interrupted; restoring previous configuration")
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        if not p["forwards"]:
            conf.unlink(missing_ok=True)
            sshd.unlink(missing_ok=True)
            keys.unlink(missing_ok=True)
            run("nginx", "-t")
            run("systemctl", "reload", "nginx")
            reload_ssh()
            journal.unlink()
            print("Public routes removed; certificates preserved")
            return

        Path("/var/lib/homenet-public/acme").mkdir(parents=True, exist_ok=True)
        atomic(conf, render(p, marker), 0o644)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
        if marker.strip() not in run("nginx", "-T"):
            raise RuntimeError("nginx does not include " + str(conf))
        for f in p["forwards"]:
            host = f["host"]
            if not Path(certificate(sid, host) + "/fullchain.pem").exists():
                args = ["certbot", "certonly", "--webroot", "-w", "/var/lib/homenet-public/acme", "--non-interactive", "--agree-tos", "--cert-name", "homenet-public-" + sid + "-" + host, "-d", host]
                args += ["--email", p["email"]] if p["email"] else ["--register-unsafely-without-email"]
                run(*args)
        atomic(conf, render(p, marker, require_tls=True), 0o644)
        run("nginx", "-t")

        active = [f for f in p["forwards"] if not f.get("disabled")]
        ports = " ".join("127.0.0.1:" + str(f["port"]) for f in active) or "none"
        sshbody = marker + "Match User " + user + "\n AllowTcpForwarding remote\n GatewayPorts no\n PermitListen " + ports + "\n PermitTTY no\n X11Forwarding no\n AllowAgentForwarding no\n MaxSessions 0\n ClientAliveInterval 15\n ClientAliveCountMax 3\nMatch all\n"
        atomic(sshd, sshbody)
        run("/usr/sbin/sshd", "-t")
        effective = run("/usr/sbin/sshd", "-T", "-C", "user=" + user + ",host=localhost,addr=127.0.0.1")
        if "allowtcpforwarding remote\n" not in effective or "maxsessions 0\n" not in effective or "gatewayports no\n" not in effective:
            raise RuntimeError("sshd config.d is not effective")
        options = "restrict,port-forwarding," + ",".join('permitlisten="127.0.0.1:' + str(f["port"]) + '"' for f in active)
        atomic(keys, options + " " + p["key"] + " homenet-public-tunnel\n" if active else "")
        run("chown", "-R", user + ":" + user, str(sshdir))
        run("chmod", "700", str(sshdir))
        reload_ssh()

        hook = Path("/etc/letsencrypt/renewal-hooks/deploy/homenet-public-nginx")
        if hook.exists() and "# HomeNet public servers" not in hook.read_text():
            raise RuntimeError("Foreign certificate hook")
        atomic(hook, "#!/bin/sh\n# HomeNet public servers\nnginx -t && systemctl reload nginx\n", 0o755)
        run("systemctl", "enable", "--now", "certbot.timer")
        run("systemctl", "reload", "nginx")
        journal.unlink()
        print("HTTPS configured; reverse ports are loopback only")
    except BaseException:
        recover()
        raise


def prepare_certificates(p):
    """Only HTTP-01 challenges; never publish a draft's application backend."""
    sid = p["id"]
    marker = "# Managed by HomeNet public servers: " + sid + "\n"
    pending = Path("/etc/nginx/conf.d/homenet-acme-" + sid + ".conf")
    if pending.exists():
        if not pending.read_text().startswith(marker):
            raise RuntimeError("Foreign ACME file")
        pending.unlink()
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
    missing = [f for f in p["forwards"] if not Path(certificate(sid, f["host"]) + "/fullchain.pem").exists()]
    if not missing:
        return
    nginx = run("nginx", "-T")
    # A missing certificate for a live route must be renewed in place, without
    # creating a conflicting HTTP vhost. The normal vhost already serves ACME.
    own = Path("/etc/nginx/conf.d/homenet-public-" + sid + ".conf")
    if own.exists() and not own.read_text().startswith(marker):
        raise RuntimeError("Foreign publication file")
    check_domains(dict(p, forwards=missing), nginx, own)
    existing = own.read_text() if own.exists() else ""
    staged = [f for f in missing if not re.search(r"server_name\s+" + re.escape(f["host"]) + r"\s*;", existing)]
    Path("/var/lib/homenet-public/acme").mkdir(parents=True, exist_ok=True)
    if staged:
        body = marker
        for f in staged:
            body += "server { listen 80; server_name " + f["host"] + "; location ^~ /.well-known/acme-challenge/ { root /var/lib/homenet-public/acme; } location / { return 503; } }\n"
        atomic(pending, body, 0o644)
    def interrupted(signum, frame):
        raise RuntimeError("Certificate preparation interrupted")
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
        for f in missing:
            args = ["certbot", "certonly", "--webroot", "-w", "/var/lib/homenet-public/acme", "--non-interactive", "--agree-tos", "--keep-until-expiring", "--cert-name", "homenet-public-" + sid + "-" + f["host"], "-d", f["host"]]
            args += ["--email", p["email"]] if p["email"] else ["--register-unsafely-without-email"]
            run(*args)
    finally:
        pending.unlink(missing_ok=True)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")


def export_certificates(p):
    items = []
    for f in p["forwards"]:
        cert = certificate(p["id"], f["host"])
        items.append(dict(host=f["host"], certificate=Path(cert + "/fullchain.pem").read_text(), key=Path(cert + "/privkey.pem").read_text()))
    print(json.dumps(items))


def main(p):
    state = Path("/var/lib/homenet-public/servers") / p["id"]
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (state / "setup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if p.get("mode") == "certificates":
            prepare_certificates(p)
            export_certificates(p)
        elif p.get("mode") == "export":
            export_certificates(p)
        else:
            configure(p)


if __name__ == "__main__":
    main(json.loads(base64.b64decode(sys.argv[1])))
