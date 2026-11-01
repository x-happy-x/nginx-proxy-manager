"""NPM-105: provision the two requested physical PCs without switching them off."""
import argparse
import base64
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PCS = [
    {'id': 'pc-x', 'name': 'PC-X', 'address': '192.168.1.10', 'port': 22, 'user': 'amagomedsharipov',
     'power_enabled': True, 'mac': 'b0:82:e2:30:92:8d', 'broadcast': '192.168.1.255'},
    {'id': 'pc-a', 'name': 'PC-A', 'address': '192.168.1.20', 'port': 22, 'user': 'amagomedsharipov',
     'power_enabled': True, 'mac': 'ac:82:47:4b:eb:d7', 'broadcast': '192.168.1.255'},
]


def command(argv, data=None):
    result = subprocess.run(argv, input=data, capture_output=True, timeout=100)
    if result.returncode:
        raise RuntimeError('Command failed: ' + Path(argv[0]).name + ': ' + result.stderr.decode(errors='replace')[-300:])
    return result.stdout


def powershell(args, code):
    prefix = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();"
    encoded = base64.b64encode((prefix + code).encode('utf-16-le')).decode()
    return command(['ssh', *args, 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded]).decode('utf-8-sig')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--only', choices=['pc-x', 'pc-a'])
    args = parser.parse_args()
    selected = [pc for pc in PCS if args.only is None or pc['id'] == args.only]
    if not args.apply:
        print(json.dumps({'computers': PCS, 'shutdown_test': False}))
        return
    branch = command(['git', '-c', 'safe.directory=' + ROOT.as_posix(), '-C', str(ROOT), 'branch', '--show-current']).decode().strip()
    assert branch == 'master', 'Deploy only from merged master'
    pub = command(['ssh', '-o', 'BatchMode=yes', 'keenetic', '/opt/bin/dropbearkey -y -f /opt/etc/homenet/pc/id_dropbear']).decode()
    pub = next(line for line in pub.splitlines() if line.startswith('ssh-'))
    pub = ' '.join(pub.split()[:2]) + ' homenet-pc@router'
    # Verify PC-X against this machine's own host public key, without changing the
    # user's known_hosts or accepting a changed host key from the network.
    runtime = ROOT / '.runtime'; runtime.mkdir(exist_ok=True)
    known = runtime / 'pc-x-known-hosts'
    try:
        public = Path('C:/ProgramData/ssh/ssh_host_ed25519_key.pub').read_text().strip()
    except PermissionError:
        # OpenSSH protects ProgramData on some Windows installations. Read the
        # same local daemon's public key over loopback; never trust a remote scan.
        scan = command(['ssh-keyscan', '-T', '5', '-t', 'ed25519', '127.0.0.1']).decode()
        public = ' '.join(next(line for line in scan.splitlines() if not line.startswith('#')).split()[1:3])
    known.write_text('192.168.1.10 ' + public + '\n')
    pinned = {}
    for pc in selected:
        identity = str(Path.home() / '.ssh/homecloud_remote_start_ed25519')
        opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-i', identity]
        if pc['id'] == 'pc-x':
            opts += ['-o', 'UserKnownHostsFile=' + str(known), '-o', 'StrictHostKeyChecking=yes']
        target = pc['user'] + '@' + pc['address']
        ssh_args = [*opts, target]
        actual = powershell(ssh_args, '[Environment]::MachineName').strip()
        assert actual.casefold() == pc['name'].casefold(), 'Computer identity mismatch'
        pinned[pc['address']] = powershell(ssh_args, "Get-Content (Join-Path $env:ProgramData 'ssh/ssh_host_ed25519_key.pub')").strip()
        powershell(ssh_args, "New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE 'homenet-power-NPM105') | Out-Null")
        dist = ROOT / 'pc-agent/dist/windows-amd64'
        command(['scp', *opts, str(dist / 'homenet-pc-agent.exe'), str(ROOT / 'pc-agent/install.ps1'),
                 target + ':homenet-power-NPM105/'])
        # Preserve the existing key's Docker/WSL permissions. PC-A gets only power
        # permission until other management is explicitly enabled for it.
        code = r'''
$auth=Join-Path $env:ProgramData 'ssh/administrators_authorized_keys'
$previous=@();if(Test-Path $auth){$previous=@(Get-Content $auth | Where-Object {$_ -match 'homenet-pc@router'})}
$base=Join-Path $env:ProgramData 'HomeNet';$backup=Join-Path $base ('backups/NPM-105-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$oldBinary=Join-Path $base 'pc-agent.exe'
if(Test-Path $oldBinary){Copy-Item -LiteralPath $oldBinary -Destination (Join-Path $backup 'pc-agent.exe')}
if(Test-Path $auth){Copy-Item -LiteralPath $auth -Destination (Join-Path $backup 'authorized_keys')}
$install=Join-Path $env:USERPROFILE 'homenet-power-NPM105/install.ps1'
$params=@{PublicKey=PUBLIC_KEY;AllowPowerActions=$true;AdministratorKeyFile=$true}
if($previous -match 'allow-docker-actions'){$params.AllowDockerActions=$true}
if($previous -match 'allow-wsl-actions'){$params.AllowWSLActions=$true}
$done=$false
for($i=0;$i -lt 20;$i++){try{& $install @params;$done=$true;break}catch{if($i -eq 19){throw};Start-Sleep -Seconds 2}}
if(!$done){throw 'Agent installation failed'}
'''.replace('PUBLIC_KEY', "'" + pub.replace("'", "''") + "'")
        output = powershell(ssh_args, code)
        reply = json.loads(output.strip().splitlines()[-1])
        assert reply['ok'] and reply['agent'] == '1.3.0', reply
        print(json.dumps({'computer': pc['id'], 'agent': reply['agent'], 'installed': True}), flush=True)
    payload = {'pcs': selected, 'keys': pinned}
    code = '''import pathlib,json,secrets,shutil,time,os,urllib.request
p=PAYLOAD
root=pathlib.Path('/opt/etc/homenet/pc');hosts=root/'hosts.json'
data=json.loads(hosts.read_text());existing={h['id']:h for h in data['hosts']}
backup=root/('backups/NPM-105-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
shutil.copy2(hosts,backup/'hosts.json')
for h in p['pcs']:
 if h['id'] in existing:
  assert existing[h['id']]['address']==h['address'] and existing[h['id']]['user']==h['user']
  existing[h['id']].update(h)
 else:data['hosts'].append(h)
trust=root/'.ssh/known_hosts';old=trust.read_text() if trust.exists() else ''
(backup/'known_hosts').write_text(old)
lines=[line for line in old.splitlines() if not any(line.split(' ')[0] in [ip,'['+ip+']:22'] for ip in p['keys'])]
for ip,key in p['keys'].items():lines.append(ip+' '+' '.join(key.split()[:2]))
trust.write_text('\\n'.join(lines)+'\\n');trust.chmod(0o600)
token=root/'power-token'
if not token.exists():
 fd=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(48))
token.chmod(0o600)
coretoken=pathlib.Path('/opt/etc/homenet/core/credentials/pc-power.token');coretoken.write_bytes(token.read_bytes());coretoken.chmod(0o600)
tmp=root/'hosts.json.new';tmp.write_text(json.dumps(data,indent=2));tmp.chmod(0o600);tmp.replace(hosts)
credential=pathlib.Path('/opt/etc/homenet/core/credentials/pc.token').read_text().strip()
request=urllib.request.Request('http://127.0.0.1:63506/api/pc/config',data=json.dumps(data).encode(),method='PUT',headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=30) as response:assert json.load(response)['ok']
print(json.dumps({'configured':[h['id'] for h in p['pcs']],'preserved_other_hosts':len(data['hosts'])-len(p['pcs'])}))
'''.replace('PAYLOAD', repr(payload))
    print(command(['ssh', '-o', 'BatchMode=yes', 'keenetic', '/opt/bin/python3 -'], code.encode()).decode(), flush=True)


if __name__ == '__main__':
    main()
