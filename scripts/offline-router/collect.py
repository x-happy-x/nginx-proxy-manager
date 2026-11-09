# Executed over SSH with common.py prepended. stdout is a private tar stream.
import hashlib
import io
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time

assert platform.machine() in ('aarch64', 'arm64'), 'Source architecture must be arm64'
out = tarfile.open(fileobj=sys.stdout.buffer, mode='w|')
seen = set()


def emit(name, data, mode=0o600):
    if name in seen:
        return
    assert not name.startswith('/') and '..' not in name.split('/')
    seen.add(name)
    info = tarfile.TarInfo(name); info.size = len(data); info.mode = mode; info.mtime = int(time.time())
    out.addfile(info, io.BytesIO(data))


def file(src, dest=None):
    if not os.path.isfile(src):
        raise RuntimeError('Required file missing: ' + src)
    emit(dest or 'payload' + src, open(src, 'rb').read(), os.stat(src).st_mode & 0o777)


def tree(src, dest, exclude=None):
    for base, dirs, files in os.walk(src, followlinks=True):
        dirs[:] = [d for d in dirs if not exclude or not exclude(d)]
        for name in files:
            if exclude and exclude(name):
                continue
            file(base+'/'+name, dest+'/'+os.path.relpath(base+'/'+name, src).replace(os.sep, '/'))


def yq(path):
    return json.loads(subprocess.check_output(['/opt/sbin/yq', '-o=json', '.', path], stderr=subprocess.PIPE))


registry = transfer_integrations(json.load(open('/opt/etc/homenet/core/registry.json')))
vpn = next(i for i in registry['items'] if i['manifest']['id'] == 'vpn')
network = next(i for i in registry['items'] if i['manifest']['id'] == 'network' and i.get('enabled'))
core_root = os.path.realpath('/opt/share/homenet/core/current')
core_version = os.path.basename(core_root)
vpn_root = '/opt/share/homenet/integrations/vpn/' + vpn['manifest']['version']
tree(core_root, 'payload/opt/share/homenet/core/releases/'+core_version)
tree(vpn_root, 'payload'+vpn_root)
network_root = '/opt/share/homenet/integrations/network/' + network['manifest']['version']
tree(network_root, 'payload'+network_root)
emit('meta/registry.json', json.dumps(registry).encode())
cfg, removed = without_tail(yq('/opt/etc/mihomo/config.yaml'))
for p in cfg.get('proxy-providers', {}).values():
    if p.get('path'):
        path = provider_path(p['path'])
        data = yq(path)
        data['proxies'] = [v for v in data.get('proxies', []) if v.get('type', '').lower() != 'tailscale']
        emit('payload'+path, json.dumps(data, ensure_ascii=False, indent=2).encode())
for p in cfg.get('rule-providers', {}).values():
    if p.get('path'):
        path = provider_path(p['path']); file(path)
for name in ('GeoIP.dat','GeoSite.dat','ASN.mmdb','geoip.metadb'):
    if os.path.isfile('/opt/etc/mihomo/'+name): file('/opt/etc/mihomo/'+name)
emit('payload/opt/etc/mihomo/config.yaml', json.dumps(cfg, ensure_ascii=False, indent=2).encode())
file('/opt/sbin/mihomo')
file('/opt/sbin/yq')
for name in ('xkeen',):
    emit('payload/opt/sbin/'+name, runtime_script(open('/opt/sbin/'+name,'rb').read()), 0o755)
for base, dirs, files in os.walk('/opt/sbin/.xkeen'):
    for name in files:
        src=base+'/'+name; rel=os.path.relpath(src,'/opt/sbin/.xkeen').replace(os.sep,'/')
        if name.endswith(('.bak','.log')): continue
        data=open(src,'rb').read()
        if name.endswith('.sh'): data=runtime_script(data)
        emit('payload/opt/sbin/.xkeen/'+rel,data,os.stat(src).st_mode & 0o777)
emit('payload/opt/etc/init.d/S05xkeen',runtime_script(open('/opt/etc/init.d/S05xkeen','rb').read()),0o755)
for name in ('xkeen.json','port_exclude.lst','port_proxying.lst','ip_exclude.lst'):
    if os.path.isfile('/opt/etc/xkeen/'+name):file('/opt/etc/xkeen/'+name)
for name in ('proxy.sh','01-mihomo-dns1053.sh'):
    src='/opt/etc/ndm/netfilter.d/'+name
    if os.path.isfile(src):emit('payload'+src,runtime_script(open(src,'rb').read()),0o755)
schedule='/opt/etc/ndm/schedule.d/00-xkeen-hotspot-sync.sh'
if os.path.isfile(schedule):emit('payload'+schedule,runtime_script(open(schedule,'rb').read()),0o755)
for name in ('olcrtc.json','olcrtc_ed25519','olcrtc_ed25519.pub'):
    path='/opt/etc/homenet/mihomo/'+name
    if os.path.isfile(path):file(path)
routing='/opt/etc/homenet/mihomo/routing.json'
if os.path.isfile(routing):
    emit('payload'+routing,json.dumps(without_tail_state(json.load(open(routing)),set(removed)),ensure_ascii=False,indent=2).encode())
sl='/opt/etc/homenet/mihomo/sublab/state.json'
if os.path.isfile(sl):
    state=without_tail_state(json.load(open(sl)),set(removed));state['every']=0
    # Already-imported file providers work without access to the subscription service.
    # Updates are manual until the target's service URL is checked in the UI.
    state['groups']=[g for g in state.get('groups',[]) if g not in removed]
    state['applied_groups']=[g for g in state.get('applied_groups',[]) if g not in removed]
    emit('payload'+sl,json.dumps(state,ensure_ascii=False,indent=2).encode())
for name in os.listdir('/opt/root/.ssh'):
    path='/opt/root/.ssh/'+name
    if os.path.isfile(path) and not any(s in name.lower() for s in ('.bak','backup','.old')):file(path)
file('/opt/etc/homenet/nginx/bin/linux-arm64/gateway','payload/opt/share/homenet/offline/gateway')
file('/opt/etc/ssl/certs/ca-certificates.crt','payload/opt/share/homenet/offline-runtime/ca-certificates.crt')

runtime='/opt/share/homenet/offline-runtime'
for name in os.listdir('/opt/lib'):
    if (name.startswith('lib') and '.so' in name) or name.startswith('ld-'):
        src='/opt/lib/'+name
        if os.path.isfile(src):file(src,'payload'+runtime+'/lib/'+name)
if os.path.isdir('/opt/lib/iptables'):tree('/opt/lib/iptables','payload'+runtime+'/xtables')
tree('/opt/lib/python3.13','payload'+runtime+'/python/lib/python3.13',
     lambda n:n in ('site-packages','test','tests','ensurepip','idlelib','tkinter'))
tools={}
for name in ('python3','curl','jq','grep','ipset','ip','yq','tar','nohup','iptables','ip6tables','iptables-save','iptables-restore','ip6tables-save','ip6tables-restore'):
    src=shutil.which(name,path='/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    if not src or not os.path.realpath(src).startswith('/opt/'):
        continue
    actual=os.path.realpath(src);target=runtime_binary_name(name,actual)
    file(actual,'payload'+runtime+'/libexec/'+target)
    tools[name]={'binary':target,'applet':name if target in ('busybox','poorbox','xtables-multi','xtables-nft-multi','xtables-legacy-multi') else ''}
busy='/opt/bin/busybox'
file(busy,'payload'+runtime+'/libexec/busybox')
applets=set(subprocess.check_output([busy,'--list']).decode().split())
for name in 'awk sed ps pidof killall logger sleep date mktemp timeout tee sha256sum gzip find xargs sort head tail cut tr wc basename dirname readlink cat mkdir cp mv rm ln chmod touch uniq id uname df du stat test which netstat nslookup insmod rmmod lsmod sysctl'.split():
    if name in applets and name not in tools: tools[name]={'binary':'busybox','applet':name}
for name, tool in tools.items():
    shell='#!/bin/sh\nr="${HOMENET_RUNTIME:-/opt/share/homenet/offline-runtime}"\n'
    shell+='export SSL_CERT_FILE="$r/ca-certificates.crt" CURL_CA_BUNDLE="$r/ca-certificates.crt"\n'
    if name=='python3':shell+='export PYTHONHOME="$r/python" PYTHONNOUSERSITE=1 LD_LIBRARY_PATH="$r/lib"\nunset PYTHONPATH\n'
    if 'tables' in name:shell+='export XTABLES_LIBDIR="$r/xtables"\n'
    binary='"$r/libexec/'+tool['binary']+'"'
    # The Go yq executable is static, unlike Entware's libc-based tools.
    is_static=tool['binary'].startswith('yq')
    shell+='exec '+('' if is_static else '"$r/lib/ld-linux-aarch64.so.1" --library-path "$r/lib" ')+binary
    if tool['applet']:shell+=' '+tool['applet']
    emit('payload'+runtime+'/bin/'+name,(shell+' "$@"\n').encode(),0o755)
source_mac=open('/sys/class/net/br0/address').read().strip()
version=subprocess.check_output(['/opt/sbin/mihomo','-v']).decode().splitlines()[0]
metadata={'schema':1,'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'arch':'arm64','kernel':platform.release(),
          'source_mac':source_mac,'core_version':core_version,'vpn_version':vpn['manifest']['version'],
          'network_version':network['manifest']['version'],
          'mihomo_version':version,'removed_tail_names':removed,'proxy_providers':len(cfg.get('proxy-providers',{})),
          'xkeen_sha256':hashlib.sha256(open('/opt/sbin/xkeen','rb').read()).hexdigest(),
          'xkeen_version':subprocess.check_output(['/opt/bin/opkg','status','xkeen']).decode().split('Version: ',1)[1].splitlines()[0],
          'private_material':['subscriptions','OLCRTC configuration and SSH key','SSH client files'],
          'excluded':['Tailscale configuration/state','source Account credentials','source routes/hosts','logs/history','SSH server host keys']}
emit('meta/source.json',json.dumps(metadata,ensure_ascii=False,indent=2).encode())
out.close()
