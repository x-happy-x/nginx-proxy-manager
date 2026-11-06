"""Offline installation. Only --apply mutates the target; --check is read-only."""
import argparse
import hashlib
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
from common import runtime_script

ROOTS = ['opt/etc/mihomo', 'opt/etc/xkeen', 'opt/sbin/mihomo', 'opt/sbin/yq', 'opt/sbin/xkeen', 'opt/sbin/.xkeen',
         'opt/etc/init.d/S04homenet-clock', 'opt/etc/init.d/S05xkeen', 'opt/etc/init.d/S99homenet-offline',
         'opt/etc/ndm/netfilter.d/proxy.sh', 'opt/etc/ndm/netfilter.d/01-mihomo-dns1053.sh',
         'opt/etc/ndm/schedule.d/00-xkeen-hotspot-sync.sh',
         'opt/share/homenet/core', 'opt/share/homenet/integrations/vpn',
         'opt/share/homenet/offline-runtime', 'opt/share/homenet/offline',
         'opt/etc/homenet/core', 'opt/etc/homenet/mihomo', 'opt/etc/homenet/offline',
         'opt/etc/homenet/nginx/config/runtime.env', 'opt/etc/homenet/nginx/routes.yml',
         'opt/etc/homenet/access.json', 'opt/root/.ssh',
         'opt/etc/nginx/sites-enabled/zashboard.local.conf']
LEGACY_SERVICE_PATTERN = r'S\d+[^/]*(?:mihomo|xkeen|zashboard|clash|nginx-manager-lite)[^/]*'
DASHBOARDS = {'opt/share/zashboard','opt/share/mihomo/ui','opt/etc/mihomo/ui',
              'opt/etc/mihomo/dashboard','opt/etc/mihomo/zashboard','opt/share/mihomo/dashboard'}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    path.chmod(0o600)


def path_exists(path):
    return path.exists() or path.is_symlink()


def remove(path):
    if path.is_symlink() or path.is_file(): path.unlink()
    elif path.exists(): shutil.rmtree(path)


def copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink(): dst.symlink_to(os.readlink(src))
    elif src.is_dir(): shutil.copytree(src, dst, symlinks=True)
    else: shutil.copy2(src, dst)


def allowed(relative, roots=ROOTS):
    p = Path(relative)
    return not p.is_absolute() and '..' not in p.parts and any(relative == r or relative.startswith(r+'/') for r in roots)


def verify(bundle):
    if any(p.is_symlink() for p in bundle.rglob('*')):raise RuntimeError('Symlinks are not permitted in the bundle')
    manifest=json.loads((bundle/'MANIFEST.json').read_text(encoding='utf-8'))
    for rel, expected in manifest['files'].items():
        p=bundle/rel
        if Path(rel).is_absolute() or '..' in Path(rel).parts or p.is_symlink() or not p.is_file():
            raise RuntimeError('Unsafe or missing bundle member: '+rel)
        if hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
            raise RuntimeError('Bundle checksum mismatch: '+rel)
        if rel.startswith('payload/') and not allowed(rel[len('payload/'):]):
            raise RuntimeError('Payload destination is outside the installation: '+rel)
    actual={p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file() and p.name!='MANIFEST.json'}
    if actual != set(manifest['files']): raise RuntimeError('Unlisted or missing bundle files')
    return manifest


def environment(runtime):
    env=os.environ.copy()
    for k in ('LD_LIBRARY_PATH','PYTHONHOME','PYTHONPATH'):env.pop(k,None)
    env['HOMENET_RUNTIME']=str(runtime)
    env['PATH']=str(runtime/'bin')+':/opt/sbin:/opt/bin:/sbin:/bin:/usr/sbin:/usr/bin'
    return env


def command(argv, runtime, log=None, timeout=90):
    result=subprocess.run([str(v) for v in argv],env=environment(runtime),stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if log is None else log,stderr=subprocess.PIPE if log is None else log,timeout=timeout)
    if result.returncode: raise RuntimeError('Command failed (details stay in the private installation log): '+str(argv[0]))
    return result.stdout


def validate_ip(value):
    ip=ipaddress.ip_address(value)
    if ip.version!=4 or ip.is_loopback or ip.is_multicast or ip.is_unspecified:
        raise RuntimeError('Use the target router LAN IPv4 address')
    return str(ip)


def discover_ip(runtime):
    text=command([runtime/'bin/ip','-4','-o','addr','show','br0'],runtime).decode()
    match=re.search(r'\binet\s+(\d+\.\d+\.\d+\.\d+)/',text)
    if not match:raise RuntimeError('Cannot detect br0 LAN address; specify --lan-ip')
    return validate_ip(match.group(1))


def init_service(core_version):
    return '''#!/bin/sh
PATH=/opt/share/homenet/offline-runtime/bin:/opt/sbin:/opt/bin:/sbin:/bin:/usr/sbin:/usr/bin
HOMENET_RUNTIME=/opt/share/homenet/offline-runtime
export PATH HOMENET_RUNTIME
umask 077
running() {
 [ -f "$1" ] || return 1
 p=$(cat "$1"); case "$p" in ''|*[!0-9]*) return 1;; esac
 [ "$(readlink "/proc/$p/exe" 2>/dev/null)" = "$(readlink -f "$2")" ] && kill -0 "$p" 2>/dev/null
}
start_one() {
 label="$1"; executable="$2"; shift 2
 pid="/opt/var/run/homenet-offline-$label.pid"
 running "$pid" "$executable" && return 0
 nohup "$executable" "$@" >>"/opt/var/log/homenet-offline-$label.log" 2>&1 </dev/null &
 echo $! > "$pid"; sleep 1
 running "$pid" "$executable"
}
stop_one() {
 pid="/opt/var/run/homenet-offline-$1.pid"; executable="$2"
 running "$pid" "$executable" || return 0
 kill "$p" || return 1
 count=0
 while running "$pid" "$executable"; do
  count=$((count+1)); [ "$count" -lt 180 ] || return 1; sleep 1
 done
 rm -f "$pid"
}
start() {
 mkdir -p /opt/var/run /opt/var/log
 start_one gateway /opt/share/homenet/offline/gateway -config /opt/etc/homenet/offline/gateway.json -hosts /opt/etc/homenet/offline/no-extra-hosts.json || return 1
 start_one core /opt/share/homenet/core/current/core -config /opt/etc/homenet/core/config.json || return 1
 start_one front /opt/share/homenet/offline/front -config /opt/etc/homenet/offline/front.json
}
stop() {
 stop_one front /opt/share/homenet/offline/front || return 1
 stop_one core /opt/share/homenet/core/current/core || return 1
 stop_one gateway /opt/share/homenet/offline/gateway
}
case "$1" in start) start;; stop) stop;; restart) stop && start;; *) exit 2;; esac
'''


def configure(target, source, lan, port):
    """Generate fresh target identity; retain subscription and OLCRTC credentials."""
    def at(p):return target/p.lstrip('/')
    host=lan+':'+str(port)
    cfgpath=at('/opt/etc/mihomo/config.yaml');cfg=json.loads(cfgpath.read_text(encoding='utf-8'))
    cfg['secret']=secrets.token_hex(32);cfg['external-controller']='127.0.0.1:9090'
    write_json(cfgpath,cfg)
    envpath=at('/opt/etc/homenet/nginx/config/runtime.env')
    envpath.write_text(envpath.read_text()+'MIHOMO_SECRET='+cfg['secret']+'\n',encoding='utf-8')
    envpath.chmod(0o600)
    state=at('/opt/etc/homenet/core');state.mkdir(parents=True,exist_ok=True)
    write_json(state/'config.json',{'listen':'127.0.0.1:18490','state_dir':'/opt/etc/homenet/core',
        'static_dir':'/opt/share/homenet/core/current/ui','packages_dir':'/opt/share/homenet/integrations',
        'account_url':'http://127.0.0.1:63414','dms_url':'http://127.0.0.1:63416',
        'dms_token_file':'/opt/etc/homenet/offline/no-dms-token',
        'worker_env':'/opt/etc/homenet/nginx/config/runtime.env','worker_app_dir':'/opt/etc/homenet/nginx',
        'access_path':'/opt/etc/homenet/access.json','manage_workers':True})
    write_json(state/'portal.json',{'apps':[],'hosts':[]})
    write_json(at('/opt/etc/homenet/access.json'),{'apps':{}})
    offline=at('/opt/etc/homenet/offline');offline.mkdir(parents=True,exist_ok=True)
    write_json(offline/'gateway.json',{'secret':secrets.token_hex(32),
        'account_api':'http://127.0.0.1:63417','account_url':'https://'+host,
        'emergency_url':'https://'+host+'/_gate/emergency','router_url':'http://127.0.0.1:80',
        'hosts':{host:{'app':'homenet','min_role':'admin'}}})
    write_json(offline/'no-extra-hosts.json',{'hosts':{}})
    write_json(offline/'front.json',{'listen':host,'host':host,'core':'http://127.0.0.1:18490',
        'gateway':'http://127.0.0.1:63415','shim':'127.0.0.1:63414',
        'cert':'/opt/etc/homenet/offline/cert.pem','key':'/opt/etc/homenet/offline/key.pem'})
    current=at('/opt/share/homenet/core/current')
    if path_exists(current):remove(current)
    current.symlink_to('releases/'+source['core_version'])
    service=at('/opt/etc/init.d/S99homenet-offline');service.parent.mkdir(parents=True,exist_ok=True)
    service.write_text(init_service(source['core_version']),encoding='utf-8');service.chmod(0o755)
    hook=at('/opt/etc/ndm/netfilter.d/01-mihomo-dns1053.sh')
    if hook.exists():hook.write_text(re.sub(r'^LAN_IP="[^"]*"','LAN_IP="'+lan+'"',hook.read_text(),flags=re.M))
    ssh=at('/opt/root/.ssh')
    if ssh.exists():
        ssh.chmod(0o700)
        for f in ssh.iterdir():
            if f.is_file():f.chmod(0o644 if f.name.endswith('.pub') else 0o600)
    return 'https://'+host+'/'


def prepare_boot(target):
    """Prepare a detached disk for its first boot without donor policy marks."""
    service=target/'opt/etc/init.d/S05xkeen'
    service.write_bytes(runtime_script(service.read_bytes()));service.chmod(0o755)
    for rel in ('opt/etc/ndm/netfilter.d/proxy.sh','opt/etc/ndm/schedule.d/00-xkeen-hotspot-sync.sh'):
        remove(target/rel)
    run=target/'opt/var/run'
    if run.is_dir() and run.resolve().is_relative_to(target.resolve()):
        for pid in run.glob('*.pid'):
            if pid.is_file() or pid.is_symlink():pid.unlink()
    # A stale router clock prevents HTTPS DNS/VPN from bootstrapping. This is
    # only a lower bound; the router's native NTP remains authoritative.
    clock=target/'opt/etc/init.d/S04homenet-clock'
    clock.write_text('''#!/bin/sh
case "$1" in start|restart) ;; *) exit 0;; esac
HOMENET_RUNTIME=/opt/share/homenet/offline-runtime
export HOMENET_RUNTIME
now=$("$HOMENET_RUNTIME/bin/date" +%s) || exit 1
case "$now" in ''|*[!0-9]*) exit 1;; esac
if [ "$now" -lt MINIMUM_EPOCH ]; then
 "$HOMENET_RUNTIME/bin/date" -u -s '@MINIMUM_EPOCH' >/dev/null || exit 1
fi
'''.replace('MINIMUM_EPOCH',str(int(time.time()))),encoding='utf-8')
    clock.chmod(0o755)


def restore(target, backup, runtime=None):
    record=json.loads((backup/'backup.json').read_text())
    if record.get('schema')!=1:raise RuntimeError('Unknown backup format')
    for rel in record.get('service_roots',[])+record.get('old_services',[]):
        if not re.fullmatch('opt/etc/init.d/'+LEGACY_SERVICE_PATTERN,rel,re.I):
            raise RuntimeError('Unsafe backup service')
    for rel in record['roots']:
        if not allowed(rel,ROOTS+list(DASHBOARDS)+record.get('service_roots',[])):
            raise RuntimeError('Unsafe backup destination')
    if runtime:
        for name in ('S99homenet-offline','S05xkeen'):
            service=target/'opt/etc/init.d'/name
            if service.exists():
                try:command([service,'stop'],runtime,timeout=200)
                except Exception:raise RuntimeError('Cannot stop new service safely; files were not restored')
        replace_dns_rules(runtime,record.get('dns_rules',[]))
    for rel in reversed(record['roots']):
        dest=target/rel;remove(dest)
        saved=backup/'files'/rel
        if path_exists(saved):copy(saved,dest)
    if runtime:
        failures=[]
        for rel in record.get('old_services',[]):
            service=target/rel
            if service.exists():
                try:command([service,'start'],runtime,timeout=90)
                except Exception:failures.append(rel)
        if failures:raise RuntimeError('Files restored but previous services require manual start: '+', '.join(failures))


def dns_rules(runtime):
    output=command([runtime/'bin/iptables','-t','nat','-S','PREROUTING'],runtime).decode()
    return [shlex.split(line) for line in output.splitlines() if 'codex_mihomo_dns1053' in shlex.split(line)]


def replace_dns_rules(runtime, saved):
    for rule in dns_rules(runtime):
        command([runtime/'bin/iptables','-t','nat','-D']+rule[1:],runtime)
    for rule in saved:
        if rule[:2]!=['-A','PREROUTING'] or 'codex_mihomo_dns1053' not in rule:
            raise RuntimeError('Unsafe DNS backup rule')
        command([runtime/'bin/iptables','-t','nat']+rule,runtime)


def preflight(bundle, lan, port):
    if Path('/opt/etc/homenet/core/config.json').exists():raise RuntimeError('Target already has HomeNet')
    for address, number in [(lan,port),('127.0.0.1',18490),('127.0.0.1',63414),('127.0.0.1',63415),('127.0.0.1',63417),('127.0.0.1',63503)]:
        with socket.socket() as s:s.bind((address,number))
    required=sum(f.stat().st_size for f in (bundle/'payload').rglob('*') if f.is_file())
    old=sum(f.stat().st_size for root in ROOTS+list(DASHBOARDS) for f in Path('/').joinpath(root).rglob('*') if f.is_file() and not f.is_symlink())
    if shutil.disk_usage('/opt').free<required+old+100*1024*1024:raise RuntimeError('Not enough /opt space for installation and backup')


def wait_for_mihomo(secret, timeout=120):
    """S05xkeen start launches a background cold start; Core readiness is earlier."""
    deadline=time.monotonic()+timeout
    while True:
        request=urllib.request.Request('http://127.0.0.1:9090/version',headers={'Authorization':'Bearer '+secret})
        try:
            with urllib.request.urlopen(request,timeout=3) as response:
                if response.status==200:return
        except (OSError,ValueError):pass
        if time.monotonic()>=deadline:raise RuntimeError('Mihomo controller did not become ready after XKeen cold start')
        time.sleep(1)


def install(bundle, target, lan, port, sandbox=False, offline=False):
    meta=verify(bundle)['source'];runtime=bundle/'payload/opt/share/homenet/offline-runtime'
    detached=sandbox or offline
    if offline:
        target=target.resolve()
        if target==Path('/') or not os.path.ismount(target/'opt'):
            raise RuntimeError('Offline preparation requires a separate mounted target/opt')
        binary=target/'opt/sbin/mihomo'
        if binary.exists():
            header=binary.read_bytes()[:20]
            if header[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(header[18:20],'little')!=183:
                raise RuntimeError('Target Mihomo does not identify an ARM64 router')
    if not detached:
        if os.geteuid()!=0 or platform.machine() not in ('aarch64','arm64'):raise RuntimeError('Root on ARM64 is required')
        if Path('/sys/class/net/br0/address').read_text().strip()==meta['source_mac']:
            raise RuntimeError('This is the source router; refusing to install its own export')
    if (target/'opt/etc/homenet/core/config.json').exists():raise RuntimeError('HomeNet already exists on this target; this bundle is for a clean HomeNet installation')
    roots=ROOTS.copy();services=[]
    init=target/'opt/etc/init.d'
    if init.exists():
        for f in init.iterdir():
            if f.is_file() and re.fullmatch(LEGACY_SERVICE_PATTERN,f.name,re.I) and not any(x in f.name for x in ('.bak','.old','~')):
                rel=f.relative_to(target).as_posix();services.append(rel)
                if rel not in roots:roots.append(rel)
    # Only known dashboard asset locations are moved; never guess arbitrary paths.
    for rel in DASHBOARDS:
        if (target/rel).exists() and not any(rel.startswith(r+'/') for r in roots):roots.append(rel)
    backup=target/'opt/var/backups'/('homenet-transfer-'+time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3))
    backup.mkdir(parents=True);backup.chmod(0o700)
    record={'schema':1,'roots':roots,'old_services':services,'service_roots':[s for s in services if s not in ROOTS]}
    if not detached:record['dns_rules']=dns_rules(runtime)
    write_json(backup/'backup.json',record)
    for rel in roots:
        if path_exists(target/rel):copy(target/rel,backup/'files'/rel)
    log=(backup/'install.log').open('wb');os.chmod(backup/'install.log',0o600)
    try:
        if not detached:
            for rel in services:command([target/rel,'stop'],runtime,log,timeout=200)
            # A standalone Mihomo service may have no init script. Do not replace a live binary.
            active=subprocess.run(['pidof','mihomo'],env=environment(runtime),capture_output=True).stdout.strip()
            if active:raise RuntimeError('A Mihomo process remains; stop its own service, then retry')
        for rel in roots:
            if rel!='opt/root/.ssh':remove(target/rel)
        for src in sorted((bundle/'payload').rglob('*')):
            if not src.is_file():continue
            rel=src.relative_to(bundle/'payload').as_posix();dest=target/rel
            if rel=='opt/root/.ssh/authorized_keys' and dest.exists():
                lines=list(dict.fromkeys(dest.read_text().splitlines()+src.read_text().splitlines()))
                dest.write_text('\n'.join(lines)+'\n');continue
            if path_exists(dest):remove(dest)
            copy(src,dest)
        copy(bundle/'meta/registry.json',target/'opt/etc/homenet/core/registry.json')
        url=configure(target,meta,lan,port)
        if offline:prepare_boot(target)
        installed=target/'opt/share/homenet/offline-runtime'
        if not detached:
            command([target/'opt/share/homenet/offline/front','-init-cert',lan,
                     '-cert',target/'opt/etc/homenet/offline/cert.pem','-key',target/'opt/etc/homenet/offline/key.pem'],installed,log)
            command([target/'opt/sbin/mihomo','-t','-d','/opt/etc/mihomo','-f','/opt/etc/mihomo/config.yaml'],installed,log)
            command([target/'opt/etc/init.d/S05xkeen','start'],installed,log,timeout=200)
            command([target/'opt/etc/init.d/S99homenet-offline','start'],installed,log,timeout=30)
            deadline=time.monotonic()+35
            while True:
                try:
                    with urllib.request.urlopen('http://127.0.0.1:18490/health/ready',timeout=3) as res:
                        if res.status==200:break
                except Exception:pass
                if time.monotonic()>deadline:raise RuntimeError('Core/VPN readiness failed')
                time.sleep(1)
            context=ssl.create_default_context(cafile=str(target/'opt/etc/homenet/offline/cert.pem'))
            browser=urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            with browser.open(url+'_gate/login',timeout=15) as response:
                page=response.read(65536)
                if response.status!=200 or b'password' not in page or '/_gate/emergency' not in response.url:
                    raise RuntimeError('Local HTTPS login flow failed')
            secret=json.loads((target/'opt/etc/mihomo/config.yaml').read_text())['secret']
            wait_for_mihomo(secret)
            hook=target/'opt/etc/ndm/netfilter.d/01-mihomo-dns1053.sh'
            if hook.exists():command([hook],installed,log)
        write_json(backup/'result.json',{'installed':not offline,'prepared_offline':offline,'url':url,'source':meta,'time':time.time()})
        print(('HomeNet prepared offline: ' if offline else 'HomeNet installed: ')+url+'\nBackup: '+str(backup))
        return backup
    except BaseException:
        log.close()
        restore(target,backup,None if detached else runtime)
        raise
    finally:
        if not log.closed:log.close()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    actions=p.add_mutually_exclusive_group(required=True)
    actions.add_argument('--check',action='store_true');actions.add_argument('--apply',action='store_true')
    actions.add_argument('--rollback',type=Path)
    actions.add_argument('--prepare-offline',type=Path,metavar='ROOT')
    p.add_argument('--bundle',type=Path,help='Verified extracted bundle (offline preparation only)')
    p.add_argument('--lan-ip');p.add_argument('--ui-port',type=int,default=63412)
    args=p.parse_args();bundle=Path(__file__).resolve().parent;target=Path('/')
    if args.prepare_offline:
        if not args.lan_ip or not 1024<=args.ui_port<=65535:raise RuntimeError('Offline preparation requires --lan-ip and a valid UI port')
        if os.geteuid()!=0:raise RuntimeError('Offline preparation requires root to preserve owner and permissions')
        install(args.bundle.resolve() if args.bundle else bundle,args.prepare_offline,
                validate_ip(args.lan_ip),args.ui_port,offline=True)
        return
    if args.bundle:raise RuntimeError('--bundle is for --prepare-offline only')
    runtime=bundle/'payload/opt/share/homenet/offline-runtime'
    if args.rollback:
        backup=args.rollback.resolve()
        if backup.parent!=Path('/opt/var/backups') or not backup.name.startswith('homenet-transfer-'):
            raise RuntimeError('Use this installer\'s exact backup directory')
        restore(target,backup,runtime);print('Previous installation restored');return
    manifest=verify(bundle)
    if not 1024<=args.ui_port<=65535:raise RuntimeError('Invalid UI port')
    lan=validate_ip(args.lan_ip) if args.lan_ip else discover_ip(runtime)
    if os.geteuid()!=0 or platform.machine() not in ('aarch64','arm64'):raise RuntimeError('Root on ARM64 is required')
    if Path('/sys/class/net/br0/address').read_text().strip()==manifest['source']['source_mac']:
        raise RuntimeError('This is the source router; use the OTHER router')
    preflight(bundle,lan,args.ui_port)
    if args.check:
        print('Checksum/architecture/address checks passed. Source: '+manifest['source']['mihomo_version'])
        print('Web interface: https://'+lan+':'+str(args.ui_port)+'/');print('No device settings changed');return
    install(bundle,target,lan,args.ui_port)


if __name__=='__main__':
    try:main()
    except Exception as e:print('ERROR: '+str(e),file=sys.stderr);sys.exit(1)
