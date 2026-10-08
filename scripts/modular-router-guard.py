#!/usr/bin/env python3
"""Router-local management cutover guard. Never restarts or reconfigures VPN engines.
Run snapshot before any change; watch under nohup before cutover. confirm is a
separate operator action after 600 seconds of successful preservation checks.
All state lives in a private deployment directory supplied as the second argument.
"""
import hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(sys.argv[2]).resolve()
if not str(ROOT).startswith("/opt/var/backups/homenet-modular/"):
    raise SystemExit("Invalid private deployment directory")
os.umask(0o077)
ROOT.mkdir(parents=True, exist_ok=True)

def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=30).decode().strip()

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def capture():
    paths = ["/opt/sbin/mihomo", "/opt/sbin/xkeen", "/opt/etc/init.d/S05xkeen",
             "/opt/etc/mihomo/config.yaml", "/etc/hosts", "/opt/dms/token",
             "/opt/etc/homenet/nginx/routes.yml", "/opt/etc/homenet/nginx/.runtime/applied.yml",
             "/opt/etc/homenet/nginx/config/runtime.env", "/opt/etc/homenet/access.json"]
    for directory in ["/opt/etc/xkeen", "/opt/etc/homenet/proxy", "/opt/etc/nginx/local-ca"]:
        if Path(directory).exists():
            paths += [str(p) for p in Path(directory).rglob("*") if p.is_file()]
    hashes = {p: digest(p) for p in paths if Path(p).is_file()}
    pids = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            if (proc / "exe").resolve() == Path("/opt/sbin/mihomo"):
                pids.append([int(proc.name), (proc / "stat").read_text().split(") ",1)[1].split()[19]])
        except (OSError, FileNotFoundError):
            pass
    if len(pids) != 1:
        raise RuntimeError("Expected exactly one active Mihomo process")
    rules = run(["ip", "rule", "show"])
    firewall = run(["iptables-save"])
    firewall = re.sub(r"\[\d+:\d+\]", "[0:0]", firewall)
    firewall = "\n".join(line for line in firewall.splitlines() if not line.startswith("#"))
    return {"hashes": hashes, "mihomo": pids, "ip_rules": rules,
            "iptables": hashlib.sha256(firewall.encode()).hexdigest()}

def verify():
    before = json.loads((ROOT / "baseline.json").read_text())
    after = capture()
    for key in before:
        if before[key] != after[key]:
            if key == "hashes":
                changed = [p for p, h in before[key].items() if after[key].get(p) != h]
                raise RuntimeError("Preservation mismatch: " + ", ".join(changed))
            raise RuntimeError("Preservation mismatch: " + key)
    for url, expected in [("https://www.cloudflare.com/cdn-cgi/trace", "200"),
                          ("https://www.gstatic.com/generate_204", "204")]:
        code = run(["curl", "--silent", "--max-time", "20", "--proxy", "http://127.0.0.1:1080",
                    "--noproxy", "", "-o", "/dev/null", "-w", "%{http_code}", url])
        if code != expected:
            raise RuntimeError("Proxy connectivity check failed")

def rollback():
    # An interrupted activation might have renamed the legacy service already.
    release = (ROOT / "release").read_text().strip()
    saved = Path("/opt/etc/init.d/.homenet-disabled-S99nginx-manager-lite")
    if saved.exists() or saved.is_symlink():
        subprocess.run(["sh", release + "/activate-modular.sh", release, "--rollback"], check=True, timeout=240)
    elif Path("/opt/etc/init.d/S99homenet-core").exists():
        raise RuntimeError("Unexpected Core state; refusing a second writer")
    else:
        subprocess.run(["/opt/etc/init.d/S99nginx-manager-lite", "start"], check=True, timeout=40)
    if (ROOT / "dms-service.before").exists() and digest("/opt/bin/dms-service") != digest(ROOT / "dms-service.before"):
        subprocess.run(["/opt/etc/init.d/S97dms", "stop"], check=True, timeout=40)
        import shutil
        shutil.copy2(ROOT / "dms-service.before", "/opt/bin/dms-service.rollback")
        os.replace("/opt/bin/dms-service.rollback", "/opt/bin/dms-service")
        subprocess.run(["/opt/etc/init.d/S97dms", "start"], check=True, timeout=40)
    (ROOT / "rolled-back").write_text("Management restored; VPN engines were not restarted\n")

def watch():
    started = time.monotonic()
    active_since = None
    while time.monotonic() - started < 2700:
        if (ROOT / "abort").exists():
            raise RuntimeError("Operator requested rollback")
        if (ROOT / "active").exists():
            if active_since is None:
                active_since = time.monotonic()
            verify()
            url = (ROOT / "ready-url").read_text().strip()
            run(["curl", "--silent", "--fail", "--max-time", "15", url])
            elapsed = int(time.monotonic() - active_since)
            (ROOT / "guard-status.json").write_text(json.dumps({"healthy_seconds": elapsed}))
            if elapsed >= 600:
                (ROOT / "guard-passed").touch()
                if (ROOT / "confirmed").exists():
                    (ROOT / "completed").touch()
                    return
        time.sleep(15)
    raise RuntimeError("Deployment confirmation timed out")

mode = sys.argv[1]
if mode == "snapshot":
    if (ROOT / "baseline.json").exists():
        raise SystemExit("Existing baseline must not be replaced")
    (ROOT / "baseline.json").write_text(json.dumps(capture(), indent=2))
    verify()
    print("Baseline captured; engine, configuration, routing and proxy connectivity verified")
elif mode == "verify":
    verify(); print("VPN and persistent configuration preserved; both proxy probes passed")
elif mode == "watch":
    try:
        watch()
    except Exception as error:
        (ROOT / "failure").write_text(str(error))
        rollback()
        raise SystemExit(1)
elif mode == "rollback":
    rollback()
else:
    raise SystemExit("Unknown guard command")
