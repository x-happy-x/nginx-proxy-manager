#!/usr/bin/env python3
"""NPM-119: install pinned Xray; credentials stay on the VPS and router."""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import shlex
import subprocess
import urllib.request
import zipfile

import paramiko

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOST = '38.180.37.198'
VERSION = '26.11.9'
DIGEST = 'b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82'
PIN = 'eI6jB8Cr8QIdFhXk7DaVYWE5ymgCjK1V1I7yYIDpkSA'
CLIENT = '/opt/etc/homenet/mihomo/ai-vless.json'


def router(command, data=None):
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'keenetic', command], input=data, capture_output=True, timeout=60)
    if p.returncode:
        raise RuntimeError('Router operation failed')
    return p.stdout


def vps_detail():
    code = r"""
import json,subprocess,sys
k=next(a['token'] for a in json.load(open('/opt/etc/homenet/hostings/accounts.json')) if a['provider']=='ishosting')
config='url = "https://api.ishosting.com/vps/482492"\nheader = '+json.dumps('X-Api-Token: '+k)+'\nheader = "User-Agent: HomeNet-hostings/1.0"\nheader = "Accept: application/json"\n'
p=subprocess.run(['/opt/bin/curl','--disable','--silent','--show-error','--proto','=https','--noproxy','*','--max-time','25','--config','-'],input=config.encode(),capture_output=True,check=True)
sys.stdout.buffer.write(p.stdout)
"""
    return json.loads(router('/opt/bin/python3 -', code.encode()))


class Pinned(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        if base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=') != PIN:
            raise RuntimeError('VPS host key changed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({'host': HOST, 'xray': VERSION, 'port': 443, 'protocol': 'VLESS REALITY Vision', 'router_rules_changed': False}))
        return
    branch = subprocess.check_output(['git', '-C', str(ROOT), '-c', 'safe.directory=' + ROOT.as_posix(), 'branch', '--show-current'], text=True).strip()
    assert branch == 'master', 'Deploy only from merged master'
    detail = vps_detail()
    assert detail['network']['public_ip'] == HOST
    access = detail['access']['ssh']
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(Pinned())
    c.connect(HOST, port=int(access['port']), username='root', password=access['users'][0]['password'], allow_agent=False, look_for_keys=False, timeout=15)

    def run(command, code=None, timeout=60):
        si, so, se = c.exec_command(command, timeout=timeout)
        if code is not None:
            si.write(code)
            si.flush()
            si.channel.shutdown_write()
        out = so.read()
        se.read()
        if so.channel.recv_exit_status():
            raise RuntimeError('VPS operation failed; inspect server service logs')
        return out

    try:
        folder = '/opt/homenet-xray/releases/' + VERSION
        exists = run('test -x ' + folder + '/xray && echo yes || true').strip() == b'yes'
        if not exists:
            print('Downloading verified official Xray release', flush=True)
            req = urllib.request.Request('https://github.com/XTLS/Xray-core/releases/download/v' + VERSION + '/Xray-linux-64.zip', headers={'User-Agent': 'HomeNet-deployment/1.0'})
            with urllib.request.urlopen(req, timeout=90) as r:
                archive = r.read(40 << 20)
            assert hashlib.sha256(archive).hexdigest() == DIGEST, 'Official asset digest mismatch'
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                binary = z.read('xray')
            print('Uploading Xray binary', flush=True)
            run('mkdir -p ' + folder)
            with c.open_sftp() as s:
                with s.file(folder + '/xray', 'wb') as f:
                    f.set_pipelined(True)
                    f.write(binary)
                s.chmod(folder + '/xray', 0o755)
        print('Validating configuration and starting isolated service', flush=True)
        result = json.loads(run('python3 -', REMOTE.replace('__VERSION__', VERSION), timeout=100))
        with c.open_sftp() as s:
            with s.file('/etc/homenet-xray/client.json', 'r') as f:
                client = json.load(f)
        assert client['server'] == HOST and client['port'] == 443
        save = "import pathlib,sys,os;p=pathlib.Path('" + CLIENT + "');os.umask(0o077);b=sys.stdin.buffer.read();t=p.with_suffix('.tmp');t.write_bytes(b);t.chmod(0o600);t.replace(p)"
        router('/opt/bin/python3 -c ' + shlex.quote(save), json.dumps(client).encode())
        print(json.dumps({'host': HOST, 'xray': VERSION, **result, 'router_client_file': CLIENT}, ensure_ascii=False))
    finally:
        c.close()


REMOTE = r"""
import os,json,pathlib,subprocess,uuid,secrets,socket,ssl,time,shutil
os.umask(0o077)
root=pathlib.Path('/opt/homenet-xray');release=root/'releases/__VERSION__';state=pathlib.Path('/etc/homenet-xray');state.mkdir(mode=0o750,exist_ok=True)
def run(argv,timeout=30):
 p=subprocess.run(argv,capture_output=True,timeout=timeout)
 if p.returncode:raise RuntimeError('Command failed: '+argv[0])
 return p.stdout.decode()
config=state/'config.json';client=state/'client.json';fresh=not config.exists()
if fresh:
 s=socket.socket()
 try:s.bind(('0.0.0.0',443))
 finally:s.close()
 candidates=[]
 for name in ['www.microsoft.com','www.cloudflare.com']:
  try:
   ctx=ssl.create_default_context();ctx.minimum_version=ssl.TLSVersion.TLSv1_3;ctx.set_alpn_protocols(['h2']);start=time.monotonic()
   with socket.create_connection((name,443),timeout=5) as raw:
    with ctx.wrap_socket(raw,server_hostname=name) as tls:
     if tls.selected_alpn_protocol()=='h2':candidates.append((time.monotonic()-start,name))
  except Exception:pass
 assert candidates,'No valid TLS1.3/h2 REALITY target'
 name=min(candidates)[1]
 keys={k.strip().lower().replace(' ',''):v.strip() for k,v in (line.split(':',1) for line in run([str(release/'xray'),'x25519']).splitlines() if ':' in line)}
 private=keys.get('privatekey');public=keys.get('publickey') or keys.get('password') or keys.get('password(publickey)');assert private and public
 uid=str(uuid.uuid4());short=secrets.token_hex(8)
 private_ranges=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','240.0.0.0/4','::/128','::1/128','fc00::/7','fe80::/10','ff00::/8']
 cfg={'log':{'loglevel':'warning'},'inbounds':[{'tag':'ai-vless','listen':'0.0.0.0','port':443,'protocol':'vless','settings':{'clients':[{'id':uid,'flow':'xtls-rprx-vision'}],'decryption':'none'},'streamSettings':{'network':'raw','security':'reality','realitySettings':{'show':False,'target':name+':443','xver':0,'serverNames':[name],'privateKey':private,'shortIds':[short],'maxTimeDiff':60000,'minClientVer':'1.8.2'}}}], 'outbounds':[{'tag':'internet','protocol':'freedom','settings':{'domainStrategy':'UseIPv4'}},{'tag':'blocked','protocol':'blackhole'}], 'routing':{'domainStrategy':'IPIfNonMatch','rules':[{'type':'field','ip':private_ranges,'outboundTag':'blocked'}]}, 'policy':{'levels':{'0':{'handshake':5,'connIdle':300,'uplinkOnly':3,'downlinkOnly':5}}}}
 config.write_text(json.dumps(cfg,indent=2));config.chmod(0o640)
 client.write_text(json.dumps({'server':'38.180.37.198','port':443,'uuid':uid,'servername':name,'public-key':public,'short-id':short,'client-fingerprint':'chrome'},indent=2));client.chmod(0o600)
assert config.exists() and client.exists()
cfg=json.loads(config.read_text());cli=json.loads(client.read_text())
if cli['servername']=='www.apple.com':
 ctx=ssl.create_default_context();ctx.minimum_version=ssl.TLSVersion.TLSv1_3;ctx.set_alpn_protocols(['h2'])
 with socket.create_connection(('www.microsoft.com',443),timeout=6) as raw:
  with ctx.wrap_socket(raw,server_hostname='www.microsoft.com') as tls:assert tls.selected_alpn_protocol()=='h2'
 cli['servername']='www.microsoft.com';cli['client-fingerprint']='chrome'
 reality=cfg['inbounds'][0]['streamSettings']['realitySettings'];reality['target']='www.microsoft.com:443';reality['serverNames']=['www.microsoft.com']
 config.write_text(json.dumps(cfg,indent=2));config.chmod(0o640);client.write_text(json.dumps(cli,indent=2));client.chmod(0o600)
cfg['inbounds'][0]['streamSettings']['realitySettings']['minClientVer']='1.8.2'
config.write_text(json.dumps(cfg,indent=2));config.chmod(0o640)
run([str(release/'xray'),'run','-test','-config',str(config)])
if subprocess.run(['id','homenet-xray'],capture_output=True).returncode:run(['useradd','--system','--no-create-home','--shell','/usr/sbin/nologin','homenet-xray'])
run(['chown','root:homenet-xray',str(state),str(config)]);state.chmod(0o750)
unit=pathlib.Path('/etc/systemd/system/homenet-xray.service')
assert not unit.exists() or 'HomeNet NPM-119' in unit.read_text(),'Unexpected existing service'
backup=state/('backup-'+str(time.time_ns()));backup.mkdir(mode=0o700)
if unit.exists():shutil.copy2(unit,backup/'service')
current=root/'current';old=str(current.resolve()) if current.exists() else None
unit.write_text('''[Unit]
Description=HomeNet NPM-119 AI VLESS REALITY
After=network-online.target
Wants=network-online.target
[Service]
User=homenet-xray
Group=homenet-xray
ExecStart=/opt/homenet-xray/current/xray run -config /etc/homenet-xray/config.json
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
MemoryMax=192M
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
''');unit.chmod(0o644)
tmp=root/'current.next';tmp.unlink(missing_ok=True);tmp.symlink_to(release);tmp.replace(current)
try:
 run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','homenet-xray']);run(['systemctl','restart','homenet-xray']);time.sleep(2)
 assert run(['systemctl','is-active','homenet-xray']).strip()=='active'
except BaseException:
 if old:
  tmp.symlink_to(old);tmp.replace(current)
  if (backup/'service').exists():shutil.copy2(backup/'service',unit)
  run(['systemctl','daemon-reload']);run(['systemctl','restart','homenet-xray'])
 else:subprocess.run(['systemctl','disable','--now','homenet-xray'],capture_output=True)
 raise
print(json.dumps({'active':True,'version':run([str(release/'xray'),'version']).splitlines()[0],'target':json.loads(client.read_text())['servername'],'backup':str(backup),'fresh':fresh}))
"""

if __name__ == '__main__':
    main()
