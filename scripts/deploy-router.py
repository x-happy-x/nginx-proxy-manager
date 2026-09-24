"""Stage or deploy HomeNet without restarting Keenetic nginx or Mihomo.

Credentials: --key with an SSH private key, otherwise the ROUTER_PASSWORD
environment variable or an interactive prompt.
The remote watchdog restores only this deployment's files and domain records.
"""
from __future__ import annotations
import argparse
import getpass
import inspect
import ipaddress
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import stat
import tempfile
import time
import urllib.error
import urllib.request

import paramiko
import yaml

APP = "/opt/etc/homenet/nginx"
PROXY = "/opt/etc/homenet/proxy"
MANAGER_PID = "/opt/var/run/nginx-manager-lite.pid"
HOSTS_BEGIN = b"# BEGIN HOMENET MANAGED HOSTS"
HOSTS_END = b"# END HOMENET MANAGED HOSTS"
MANAGED_HEADERS = (b"managed by homenet-nginx-yaml", b"managed by crubs-nginx-yaml")

def q(value: str) -> str:
    return shlex.quote(value)

def split_hosts_block(body):
    """Return exact bytes surrounding the one manager-owned block."""
    start = end = None
    offset = 0
    for line in body.splitlines(keepends=True):
        marker = line.strip()
        if marker == HOSTS_BEGIN:
            if start is not None or end is not None:
                raise ValueError("Duplicate HomeNet hosts block")
            start = offset
        elif marker == HOSTS_END:
            if start is None or end is not None:
                raise ValueError("Invalid HomeNet hosts block")
            end = offset + len(line)
        offset += len(line)
    if start is None:
        return body, b"", b""
    if end is None:
        raise ValueError("Unterminated HomeNet hosts block")
    return body[:start], body[start:end], body[end:]

def restore_hosts_block(hosts_path, before_path):
    """Restore our block while retaining concurrent foreign hosts changes."""
    link = Path(hosts_path)
    target = link.resolve(strict=True)
    info = target.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("System hosts target is not a regular file")
    current = target.read_bytes()
    prefix, _, suffix = split_hosts_block(current)
    _, previous, _ = split_hosts_block(Path(before_path).read_bytes())
    separator = b"\n" if previous and prefix and not prefix.endswith(b"\n") else b""
    trailing = b"\n" if previous and suffix and not previous.endswith(b"\n") else b""
    restored = prefix + separator + previous + trailing + suffix
    if restored == current:
        return
    fd, staged = tempfile.mkstemp(prefix=".homenet-rollback-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(restored)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(staged, stat.S_IMODE(info.st_mode))
        if hasattr(os, "chown"):
            os.chown(staged, info.st_uid, info.st_gid)
        if link.resolve(strict=True) != target or target.read_bytes() != current:
            raise RuntimeError("System hosts changed during rollback; no file was replaced")
        os.replace(staged, target)
    finally:
        if os.path.lexists(staged):
            os.unlink(staged)

def managed_nginx_candidates(doc):
    """Only paths this version of the generator can create for the candidate."""
    paths = {"conf.d/npm_maps_v3.conf", "snippets/npm_proxy_v3.conf"}
    if doc.get("globals", {}).get("stub", {}).get("enabled", True):
        paths.add("conf.d/npm_stub_v3.conf")
    for host in doc.get("hosts", []):
        name = host["host"]
        if not isinstance(name, str) or not name or any(c in name for c in "/\\\x00\r\n") or name in (".", ".."):
            raise ValueError("Invalid hostname in nginx rollback manifest")
        paths.add("sites-enabled/" + name + ".conf")
        if host.get("tls", {}).get("cert_policy") == "keenetic":
            paths.add("conf.d/npm_keenetic_v3.conf")
    return sorted(paths)

def remove_new_managed_configs(proxy_path, before_path, manifest_path):
    """Never sweep directories or remove pre-existing/foreign configuration."""
    if Path(proxy_path).is_symlink():
        raise ValueError("Refusing nginx rollback root symlink")
    root = Path(proxy_path).resolve(strict=True)
    before = Path(before_path)
    paths = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    removals = []
    allowed_fixed = {"conf.d/npm_maps_v3.conf", "conf.d/npm_stub_v3.conf", "conf.d/npm_keenetic_v3.conf", "snippets/npm_proxy_v3.conf"}
    for relative in paths:
        parts = relative.split("/")
        is_site = len(parts) == 2 and parts[0] == "sites-enabled" and parts[1].endswith(".conf")
        if (relative not in allowed_fixed and not is_site) or any(p in ("", ".", "..") or "\\" in p for p in parts):
            raise ValueError("Invalid managed nginx rollback path")
        target = root.joinpath(*parts)
        if target.parent.resolve(strict=True) != root / parts[0]:
            raise ValueError("Refusing managed nginx directory symlink")
        if os.path.lexists(before.joinpath(*parts)) or not os.path.lexists(target):
            continue
        if target.is_symlink() or not target.is_file():
            raise ValueError("Refusing changed nginx rollback target: " + relative)
        body = target.read_bytes()
        if not any(header in body[:256] for header in MANAGED_HEADERS):
            raise ValueError("Refusing foreign nginx rollback target: " + relative)
        removals.append((target, body))
    for target, body in removals:
        if target.is_symlink() or target.read_bytes() != body:
            raise RuntimeError("Nginx config changed during rollback: " + str(target))
        target.unlink()

def stop_verified_manager(executable, pid_path):
    """Stop only the exact executable recorded in this manager's PID file."""
    pid_file = Path(pid_path)
    try:
        recorded = pid_file.read_text().strip()
    except FileNotFoundError:
        return
    if not recorded.isascii() or not recorded.isdecimal() or int(recorded) < 2:
        raise ValueError("Invalid manager PID; no process signalled")
    pid = int(recorded)
    expected = os.fsencode(executable)

    def still_owned():
        try:
            argv = Path("/proc", str(pid), "cmdline").read_bytes()
        except FileNotFoundError:
            return False
        if not argv:  # An exited zombie has no command line and needs no signal.
            return False
        if argv.split(b"\x00", 1)[0] != expected:
            raise RuntimeError("Manager PID belongs to a different executable; no process signalled")
        return True

    for sig, attempts in ((signal.SIGTERM, 100), (signal.SIGKILL, 20)):
        if not still_owned():
            break
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        for _ in range(attempts):
            if not still_owned():
                break
            time.sleep(0.1)
        else:
            continue
        break
    if still_owned():
        raise RuntimeError("Verified manager did not stop")
    # Do not unlink a PID file replaced by a new startup during the wait.
    try:
        if pid_file.read_text().strip() == recorded:
            pid_file.unlink()
    except FileNotFoundError:
        pass

def remote_rollback_source():
    """The router helper needs only the already-installed Python standard library."""
    source = "import json, os, signal, stat, sys, tempfile, time\nfrom pathlib import Path\n"
    source += "HOSTS_BEGIN = " + repr(HOSTS_BEGIN) + "\nHOSTS_END = " + repr(HOSTS_END) + "\n"
    source += "MANAGED_HEADERS = " + repr(MANAGED_HEADERS) + "\n"
    for function in (split_hosts_block, restore_hosts_block, remove_new_managed_configs, stop_verified_manager):
        source += "\n" + inspect.getsource(function)
    source += "\nif __name__ == '__main__':\n"
    source += "    if sys.argv[1] == 'hosts': restore_hosts_block(*sys.argv[2:])\n"
    source += "    elif sys.argv[1] == 'nginx': remove_new_managed_configs(*sys.argv[2:])\n"
    source += "    elif sys.argv[1] == 'stop-manager': stop_verified_manager(*sys.argv[2:])\n"
    source += "    else: raise ValueError('Unknown rollback operation')\n"
    return source

class Router:
    def __init__(self, host, port, user, password, local, key_filename=None):
        self.client = paramiko.SSHClient()
        self.client.load_system_host_keys()
        known = local / "router-known-hosts"
        if known.exists():
            self.client.load_host_keys(str(known))
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        if key_filename:
            self.client.connect(host, port=port, username=user, key_filename=key_filename, look_for_keys=False, allow_agent=False, timeout=12)
        else:
            self.client.connect(host, port=port, username=user, password=password, timeout=12)
        self.client.save_host_keys(str(known))
    def run(self, command, timeout=60):
        _, out, err = self.client.exec_command(command, timeout=timeout)
        result = out.read().decode("utf-8", "replace") + err.read().decode("utf-8", "replace")
        code = out.channel.recv_exit_status()
        if code:
            raise RuntimeError(f"Remote command failed ({code}): {command}\n{result[:2000]}")
        return result
    def upload(self, remote, data, mode=0o600):
        self.run("mkdir -p " + q(str(Path(remote).parent).replace("\\", "/")))
        stream, out, err = self.client.exec_command("cat > " + q(remote), timeout=60)
        stream.channel.sendall(data)
        stream.channel.shutdown_write()
        if out.channel.recv_exit_status():
            raise RuntimeError(err.read().decode())
        self.run(f"chmod {mode:o} " + q(remote))
    def exists(self, path):
        return self.run("if [ -e "+q(path)+" ]; then echo yes; fi").strip() == "yes"

def local_api(base, path, data=None, timeout=90):
    body = json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(base+path, body, {"Content-Type":"application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    attempts=3 if data is None or path=="/api/apply/check" else 1
    for attempt in range(attempts):
        try:
            with opener.open(request, timeout=timeout) as response:
                return json.load(response)
        except (ConnectionError, TimeoutError, urllib.error.URLError):
            if attempt+1==attempts: raise
            time.sleep(1)

def ndns_names(doc):
    names=[]
    for host in (doc or {}).get("hosts", []):
        for ep in host.get("endpoints", []):
            behavior=ep.get("behavior", {})
            if str(ep.get("name", "")).strip().lower() == "ndns" or behavior.get("ndns_profile"):
                names.append(str(behavior.get("ndns_name") or "").strip() or host["host"].split(".")[0])
                # Match the manager's first effective NDNS endpoint ownership.
                break
    return sorted(set(names))

def dns_pair(host, address):
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return host.lower(), str(ip)

def route_dns_pairs(doc):
    """Resolve only addresses recorded in this candidate/applied document."""
    doc = doc or {}
    ips = doc.get("globals", {}).get("listen_ips", [])
    pairs = set()
    for host in doc.get("hosts", []):
        dns = host.get("dns", {})
        if "local" not in dns.get("publish", []):
            continue
        address = dns.get("local_record_ip")
        if not address or address == "auto":
            if not ips:
                raise ValueError("Cannot prove DNS rollback ownership without an explicit listener IP: " + host["host"])
            address = ips[0]
        pairs.add(dns_pair(host["host"], address))
    return pairs

def rollback_router_commands(config, doc, previous=None):
    """Restore touched records from running config, scoped by applied ownership."""
    lines=config.splitlines()
    commands=[]
    candidate_names = set(ndns_names(doc))
    for name in sorted(candidate_names | set(ndns_names(previous))):
        prefix="ip http proxy "+name
        try:
            index=lines.index(prefix)
        except ValueError:
            if name in candidate_names:
                commands.append("no "+prefix)
            continue
        # Cleanup may have removed the complete old managed proxy.
        commands.append(prefix)
        ssl_redirect = False
        for line in lines[index+1:]:
            if not line.startswith(" "): break
            part=line.strip()
            if part.startswith(("upstream ", "domain ", "security-level ", "ssl redirect")):
                commands.append(prefix+" "+part)
            if part == "ssl redirect":
                ssl_redirect = True
        if not ssl_redirect:
            commands.append("no " + prefix + " ssl redirect")
    current_dns={}
    for line in lines:
        parts=line.split()
        if len(parts)==4 and parts[:2]==["ip","host"]:
            current_dns[dns_pair(parts[2], parts[3])] = (parts[2], parts[3])
    # Remove only exact pairs that this candidate could have added. Keep every
    # pre-existing address, including foreign addresses on the same hostname.
    for host, address in sorted(route_dns_pairs(doc) - current_dns.keys()):
        commands.append("no ip host " + host + " " + address)
    # Only the successfully applied snapshot grants removal ownership. A stale
    # snapshot pair absent from running config must not be resurrected.
    for pair in sorted(route_dns_pairs(previous) & current_dns.keys()):
        host, address = current_dns[pair]
        commands.append("ip host " + host + " " + address)
    commands.append("system configuration save")
    return commands

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host",default="192.168.1.1")
    parser.add_argument("--port",type=int,default=222)
    parser.add_argument("--user",default="root")
    parser.add_argument("--key",help="SSH private key for the router, used instead of a password")
    parser.add_argument("--activate",action="store_true",help="Apply routes and promote the staged runtime after all checks")
    parser.add_argument("--routes",default="routes.yml",help="Candidate routes; use an exported live config for subsequent upgrades")
    args=parser.parse_args()
    try:
        with socket.create_connection((args.host,63414),timeout=2):
            raise RuntimeError("Staging port 63414 is already in use; stop the previous staged manager first")
    except (ConnectionRefusedError, TimeoutError, OSError):
        pass
    root=Path(__file__).resolve().parents[1]
    local=root/".local";local.mkdir(exist_ok=True)
    required=[root/"bin/linux-arm64"/x for x in ["manager","nginx","homenet"]]
    required += [root/"frontend/static/react/index.html",root/args.routes]
    for file in required:
        if not file.is_file(): raise RuntimeError(f"Build artifact missing: {file}")
    key=os.path.expanduser(args.key) if args.key else None
    password=None if key else os.environ.get("ROUTER_PASSWORD") or getpass.getpass("Router password: ")
    router=Router(args.host,args.port,args.user,password,local,key)
    router_python=router.run("command -v python3").strip()
    if not router_python.startswith("/") or any(c in router_python for c in "\r\n\x00"):
        raise RuntimeError("An absolute router python3 path is required for rollback; no deployment started")
    router.run(q(router_python)+" -c "+q("import json, os, pathlib, signal, stat, tempfile, time; assert hasattr(os, 'replace')"))
    baseline=router.run("cat /tmp/nginx/nginx.pid; pidof mihomo").split()
    internet_before=router.run("curl --noproxy '*' --max-time 12 -sS -o /dev/null -w '%{http_code}' https://example.com").strip()
    if internet_before != "200": raise RuntimeError("Internet baseline probe did not return HTTP 200; no deployment started")
    stamp=time.strftime("%Y%m%d-%H%M%S")
    release="/opt/etc/homenet/releases/"+stamp
    result={"release":release,"activated":False}
    router.run("mkdir -p "+q(release+"/before"))
    before=router.run("ndmc -c 'show running-config'")
    (local/("running-before-"+stamp+".txt")).write_text(before,encoding="utf-8")
    doc=yaml.safe_load((root/args.routes).read_text(encoding="utf-8"))
    # Snapshot only HomeNet files plus system hosts. The network config is never replaced.
    router.run("cp -a "+q(APP)+" "+q(release+"/before/app")+" && cp -p /etc/hosts "+q(release+"/before/hosts"))
    applied_before=release+"/before/app/.runtime/applied.yml"
    previous=None
    if router.exists(applied_before):
        previous=yaml.safe_load(router.run("cat "+q(applied_before)))
        if not isinstance(previous, dict):
            raise ValueError("Previous applied snapshot is invalid; no deployment started")
    restores=rollback_router_commands(before,doc,previous)
    router.run("mkdir -p "+q(release+"/before/installed-init"))
    for name in ["S20-nginx-ips","S98nginx-local-conf","S99nginx-manager-lite"]:
        router.run("cat "+q("/opt/etc/init.d/"+name)+" > "+q(release+"/before/installed-init/"+name)+" && chmod 755 "+q(release+"/before/installed-init/"+name))
    proxy_existed=router.exists(PROXY+"/nginx.conf")
    if router.exists(PROXY): router.run("cp -a "+q(PROXY)+" "+q(release+"/before/proxy"))
    router.upload(release+"/rollback-files.py",remote_rollback_source().encode(),0o600)
    router.upload(release+"/managed-candidates.json",json.dumps(managed_nginx_candidates(doc)).encode(),0o600)
    for file in required[:3]:
        router.upload(release+"/bin/"+file.name,file.read_bytes(),0o755)
    router.upload(release+"/routes.yml",(root/args.routes).read_bytes())
    router.upload(release+"/runtime.env",(root/"config/runtime.env").read_bytes())
    for file in (root/"frontend/static").rglob("*"):
        if file.is_file(): router.upload(release+"/static/"+file.relative_to(root/"frontend/static").as_posix(),file.read_bytes(),0o644)
    for file in (root/"init.d").glob("S*"):
        if file.is_file(): router.upload(release+"/init.d/"+file.name,file.read_bytes(),0o755)
    if not proxy_existed or not router.exists(APP+"/.runtime/applied.yml"):
        router.run("mkdir -p "+q(PROXY+"/conf.d")+" "+q(PROXY+"/sites-enabled")+" "+q(PROXY+"/snippets")+" /opt/var/log/homenet")
        router.upload(PROXY+"/nginx.conf",(root/"config/nginx.conf").read_bytes(),0o644)
        router.run("/usr/sbin/nginx -p "+q(PROXY+"/")+" -c "+q(PROXY+"/nginx.conf")+" -t")
    router.run("HOME_NET_APP_DIR="+q(release+"/isolated")+" sh "+q(release+"/init.d/S98nginx-local-conf")+" start")
    # Test manager is on a distinct port, with all filesystem paths explicit.
    variables={
        "CONFIG_ENV_PATH":release+"/runtime.env", "ROUTES_PATH":release+"/routes.yml",
        "GEN_ROUTES_PATH":release+"/bin/nginx", "STATIC_ROOT":release+"/static",
        "STATS_STATE_PATH":release+"/stats.gz", "MAINTENANCE_DISABLED":"1",
        "LITE_UI_HOST":args.host, "LITE_UI_PORT":"63414",
    }
    start_script="#!/bin/sh\nset -eu\ncd "+q(APP)+"\n"
    start_script += "\n".join("export "+key+"="+q(value) for key,value in variables.items())+"\n"
    start_script += "nohup "+q(release+"/bin/manager")+" >"+q(release+"/manager.log")+" 2>&1 </dev/null &\necho $! > "+q(release+"/manager.pid")+"\n"
    router.upload(release+"/start-staged.sh",start_script.encode(),0o700)
    router.run("sh "+q(release+"/start-staged.sh"))
    base=f"http://{args.host}:63414"
    for _ in range(30):
        try:
            local_api(base,"/api/routes",timeout=3);break
        except Exception: time.sleep(1)
    else: raise RuntimeError("Staged manager failed to start")
    try:
        check=local_api(base,"/api/apply/check",{})
    except Exception:
        router.run("pid=$(cat "+q(release+"/manager.pid")+"); if tr '\\000' ' ' < /proc/$pid/cmdline | grep -F "+q(release+"/bin/manager")+" >/dev/null; then kill \"$pid\"; fi")
        raise
    (local/("preflight-"+stamp+".json")).write_text(json.dumps(check,ensure_ascii=False,indent=2),encoding="utf-8")
    if not check.get("ok"):
        router.run("kill $(cat "+q(release+"/manager.pid")+")")
        raise RuntimeError("Preflight failed: "+str(check.get("output")))
    print("Staged preflight passed:",release,flush=True)
    if not args.activate:
        print("No public mapping changed. Staged manager:",base,flush=True)
        return
    restore_lines=["run_ndmc "+q(command) for command in restores]
    restore_binary=[]
    for name in ["manager","nginx","homenet"]:
        source=release+"/before/app/bin/linux-arm64/"+name
        target=APP+"/bin/linux-arm64/"+name
        restore_binary.append("cp -p "+q(source)+" "+q(target+".restore")+" && mv "+q(target+".restore")+" "+q(target))
    rollback_helper=q(router_python)+" "+q(release+"/rollback-files.py")
    restore_proxy=(
        rollback_helper+" nginx "+q(PROXY)+" "+q(release+"/before/proxy")+" "+q(release+"/managed-candidates.json")+"\n"+
        "cp -a "+q(release+"/before/proxy/.")+" "+q(PROXY+"/")+"\n"+
        "HOME_NET_APP_DIR="+q(release+"/isolated")+" sh "+q(release+"/init.d/S98nginx-local-conf")+" reload"
        if proxy_existed else
        "HOME_NET_APP_DIR="+q(release+"/isolated")+" sh "+q(release+"/init.d/S98nginx-local-conf")+" stop\n"+
        rollback_helper+" nginx "+q(PROXY)+" "+q(release+"/before/proxy")+" "+q(release+"/managed-candidates.json")
    )
    rollback=(
        "#!/bin/sh\nset -eu\nfailed=0\n"+
        "run_ndmc() { check_absent=0; case \"$1\" in 'no ip host '*) check_absent=1;; 'no ip http proxy '*) name=${1#no ip http proxy }; case \"$name\" in *' '*) ;; *) check_absent=1;; esac;; esac; if [ \"$check_absent\" -eq 1 ]; then positive=${1#no }; if current=$(ndmc -c 'show running-config'); then printf '%s\\n' \"$current\" | grep -Fx \"$positive\" >/dev/null || return 0; else failed=1; return 0; fi; fi; if out=$(ndmc -c \"$1\" 2>&1); then case \"$out\" in *'error['*|*'unknown command'*) echo \"$out\" >&2; failed=1;; esac; else echo \"$out\" >&2; failed=1; fi; }\n"+
        rollback_helper+" stop-manager "+q(release+"/bin/manager")+" "+q(release+"/manager.pid")+"\n"+
        rollback_helper+" stop-manager "+q(APP+"/bin/linux-arm64/manager")+" "+q(MANAGER_PID)+"\n"+
        "\n".join(restore_lines)+"\n"+
        rollback_helper+" hosts /etc/hosts "+q(release+"/before/hosts")+" || failed=1\n"+
        restore_proxy+"\n"+
        "\n".join(restore_binary)+"\n"+
        "cp -p "+q(release+"/before/app/routes.yml")+" "+q(APP+"/routes.yml")+"\n"+
        "cp -p "+q(release+"/before/app/config/runtime.env")+" "+q(APP+"/config/runtime.env")+"\n"+
        "cp -a "+q(release+"/before/app/frontend/.")+" "+q(APP+"/frontend/")+"\n"+
        "cp -a "+q(release+"/before/app/init.d/.")+" "+q(APP+"/init.d/")+"\n"+
        "if [ -d "+q(release+"/before/app/.runtime")+" ]; then cp -a "+q(release+"/before/app/.runtime/.")+" "+q(APP+"/.runtime/")+"; else rm -f "+q(APP+"/.runtime/applied.yml")+" "+q(APP+"/.runtime/keenetic.sha256")+"; fi\n"+
        "for name in S20-nginx-ips S98nginx-local-conf S99nginx-manager-lite; do cp -p "+q(release+"/before/installed-init")+"/\"$name\" /opt/etc/init.d/\"$name\".restore && mv /opt/etc/init.d/\"$name\".restore /opt/etc/init.d/\"$name\"; done\n"+
        "sh "+q(APP+"/init.d/S99nginx-manager-lite")+" start\n"+
        "[ \"$failed\" -eq 0 ]\n"
    )
    router.upload(release+"/rollback.sh",rollback.encode(),0o700)
    watch="#!/bin/sh\nsleep 180\n[ -f "+q(release+"/COMMITTED")+" ] || sh "+q(release+"/rollback.sh")+"\n"
    router.upload(release+"/watchdog.sh",watch.encode(),0o700)
    router.run("nohup sh "+q(release+"/watchdog.sh")+" >"+q(release+"/watchdog.log")+" 2>&1 </dev/null &")
    try:
        # The main manager has its own maintenance loop and operation mutex.
        # Pause that process only after unattended rollback is armed; nginx and
        # Mihomo keep serving traffic throughout the staged apply/promotion.
        router.run(rollback_helper+" stop-manager "+q(APP+"/bin/linux-arm64/manager")+" "+q(MANAGER_PID))
        applied=local_api(base,"/api/apply",{},timeout=120)
        (local/("apply-"+stamp+".json")).write_text(json.dumps(applied,ensure_ascii=False,indent=2),encoding="utf-8")
        if not applied.get("ok"): raise RuntimeError(str(applied.get("output")))
        print(applied.get("output",""),flush=True)
        # Move replacement executables atomically; never overwrite a running inode.
        for name in ["manager","nginx","homenet"]:
            router.run("cp -p "+q(release+"/bin/"+name)+" "+q(APP+"/bin/linux-arm64/"+name+".new")+" && mv "+q(APP+"/bin/linux-arm64/"+name+".new")+" "+q(APP+"/bin/linux-arm64/"+name))
        router.run("cp -p "+q(release+"/routes.yml")+" "+q(APP+"/routes.yml")+
                   " && cp -p "+q(release+"/runtime.env")+" "+q(APP+"/config/runtime.env")+
                   " && cp -a "+q(release+"/static/.")+" "+q(APP+"/frontend/static/")+
                   " && cp -a "+q(release+"/init.d/.")+" "+q(APP+"/init.d/"))
        for name in ["S20-nginx-ips","S98nginx-local-conf","S99nginx-manager-lite"]:
            router.run("cp -p "+q(APP+"/init.d/"+name)+" "+q("/opt/etc/init.d/"+name+".new")+" && mv "+q("/opt/etc/init.d/"+name+".new")+" "+q("/opt/etc/init.d/"+name))
        router.run("sh "+q(APP+"/init.d/S99nginx-manager-lite")+" restart")
        time.sleep(2)
        live=f"http://{args.host}:63412"
        status=local_api(live,"/api/nginx/status")
        if not status.get("status",{}).get("running"): raise RuntimeError("Dedicated proxy health check failed")
        local_api(live,"/api/nginx/stats?window=1h")
        health=router.run("curl --noproxy '*' --max-time 5 -fsS http://127.0.0.1:63413/health").strip()
        if health != "homenet-proxy-ok": raise RuntimeError("Dedicated proxy health endpoint failed")
        # Validate real local and public ingress with TLS verification enabled.
        for host,kind,ip,port in [("sub.local","http","192.168.1.2",80),("sub.crubs.crazedns.ru","https","192.168.1.2",443),("sub.crubs.crazedns.ru","https",args.host,443)]:
            if not any(h.get("host")==host for h in doc.get("hosts",[])): continue
            code=router.run("curl --noproxy '*' --max-time 10 -sS -o /dev/null -w '%{http_code}' --resolve "+q(f"{host}:{port}:{ip}")+" "+q(f"{kind}://{host}/")).strip()
            if code not in ["200","301","302","303","307","308","401","403"]: raise RuntimeError(f"Route probe failed for {host} via {ip}: {code}")
        if router.run("cat /tmp/nginx/nginx.pid; pidof mihomo").split() != baseline:
            raise RuntimeError("Core router process identities changed during deployment")
        if router.run("curl --noproxy '*' --max-time 12 -sS -o /dev/null -w '%{http_code}' https://example.com").strip() != internet_before:
            raise RuntimeError("Internet health probe changed during deployment")
        router.run("touch "+q(release+"/COMMITTED"))
        result["activated"]=True;result["url"]=live;result["rollback"]=release+"/rollback.sh"
        (local/"last-deployment.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
        print(json.dumps(result),flush=True)
    except Exception:
        router.run("sh "+q(release+"/rollback.sh"))
        # Prevent the watchdog repeating a rollback already completed.
        router.run("touch "+q(release+"/COMMITTED"))
        raise
    finally:
        # Stop only the staged manager, never a process selected by name alone.
        router.run("for p in /proc/[0-9]*/cmdline; do [ -r \"$p\" ] || continue; cmd=$(tr '\\000' ' ' < \"$p\"); case \"$cmd\" in "+q(release+"/bin/manager")+"*) pid=${p#/proc/}; pid=${pid%/cmdline}; kill \"$pid\";; esac; done")
    router.client.close()

if __name__=="__main__":
    main()
