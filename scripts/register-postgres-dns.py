#!/usr/bin/env python3
"""NPM-109: register pg-db.local in the router DNS displayed by HomeNet.

Uses the same ndmc ip-host operation as /api/ip-hosts/add, over the existing
administrative SSH connection. No HTTP route, proxy or WAN entry is created.
Default is read-only; --apply persists DNS and a system-hosts restore hook.
"""
import argparse
import subprocess

REMOTE = r"""
from pathlib import Path
import datetime,re,shutil,socket,subprocess,sys
apply=sys.argv[1]=='apply'
name='pg-db.local';address='192.168.99.14';previous='192.168.99.37'
if not socket.gethostname().startswith(('Netcraze-','Keenetic-')):raise RuntimeError('Expected home router')
def command(value):
 r=subprocess.run(['ndmc','-c',value],text=True,capture_output=True,check=True)
 if 'error[' in (r.stdout+r.stderr).lower():raise RuntimeError('Router rejected DNS operation')
 return r.stdout
dns=command('show dns-proxy')
records=re.findall(r'^static_a = pg-db\.local (\S+) ',dns,re.M)
if any(x not in (address,previous) for x in records):raise RuntimeError('Conflicting router DNS record')
hosts=Path('/etc/hosts');original=hosts.read_text()
present=False
for line in original.splitlines():
 fields=line.split('#',1)[0].split()
 if len(fields)>1 and name in fields[1:]:
  if fields[0] not in (address,previous):raise RuntimeError('Conflicting system hosts record')
  if fields[0]==address:present=True
if not re.search(r'^\s*use-system-hosts:\s*true\s*$',Path('/opt/etc/mihomo/config.yaml').read_text(),re.M):raise RuntimeError('Expected existing Mihomo system hosts mode')
print('pg-db.local -> '+address+'; current DNS addresses='+','.join(sorted(set(records))))
if not apply:sys.exit(0)
init=Path('/opt/etc/init.d/S99homenet-pg-db-name')
if init.exists() and '# NPM-109' not in init.read_text():raise RuntimeError('Unmanaged startup hook')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/opt/etc/homeapps-postgres-dns')/stamp
backup.mkdir(parents=True,mode=0o700)
shutil.copy2(hosts,backup/'hosts');(backup/'hosts').chmod(0o600)
if init.exists():shutil.copy2(init,backup/'startup-hook')
init.write_text('''#!/opt/bin/sh
# NPM-109: PostgreSQL local DNS; same record is visible in HomeNet DNS.
# NPM-111: s1 addresses .10-.19; replace only the previous managed .37 line.
case "$1" in
 start|restart|"")
  sed -i '/^192\\.168\\.99\\.37[[:space:]][[:space:]]*pg-db\\.local[[:space:]]*$/d' /etc/hosts
  if ! awk '$1 == "192.168.99.14" {for(i=2;i<=NF;i++) if($i=="pg-db.local") found=1} END {exit !found}' /etc/hosts; then
   printf '\\n# NPM-111 PostgreSQL\\n192.168.99.14 pg-db.local\\n' >> /etc/hosts
  fi
  ;;
 stop) ;;
 *) exit 1 ;;
esac
''')
init.chmod(0o755)
subprocess.run(['/opt/bin/sh','-n',str(init)],check=True)
# Preserve unrelated aliases if the old address shared a hosts line.
lines=[]
for line in original.splitlines():
 fields=line.split('#',1)[0].split()
 if len(fields)>1 and name in fields[1:]:
  remaining=[alias for alias in fields[1:] if alias!=name]
  if remaining:lines.append(fields[0]+' '+' '.join(remaining))
 else:lines.append(line)
hosts.write_text('\n'.join(lines)+'\n'+address+' '+name+'\n')
subprocess.run(['/opt/bin/sh',str(init),'start'],check=True)
if address not in records:command('ip host '+name+' '+address)
if previous in records:command('no ip host '+name+' '+previous)
command('system configuration save')
updated=re.findall(r'^static_a = pg-db\.local (\S+) ',command('show dns-proxy'),re.M)
if set(updated)!={address}:raise RuntimeError('DNS verification failed after save')
print('Saved; PostgreSQL port is 5432; no proxy/WAN publication')
"""

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','keenetic',
                    'python3 - '+('apply' if args.apply else 'inspect')],input=REMOTE.encode(),check=True)
