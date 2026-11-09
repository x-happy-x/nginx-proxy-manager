"""NPM-120: update modular Core/hosting integration from master, with lifecycle rollback."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.6.120'


def ssh(code, data=None, timeout=180):
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'keenetic', code],
                            input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Router operation failed: ' + result.stderr.decode(errors='replace')[-700:])
    return result.stdout.decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({'core': VERSION, 'integrations': ['hostings'], 'router_config_changes': False}))
        return
    branch = subprocess.check_output(['git', '-c', 'safe.directory=' + ROOT.as_posix(), '-C', str(ROOT), 'branch', '--show-current'], text=True).strip()
    assert branch == 'master', 'Deploy only from merged master'
    source = ROOT / '.runtime/modules/linux-arm64'
    destination = '/opt/share/homenet'
    files = {}
    for name in ['core', 'hostings']:
        folder = source / name if name == 'core' else source / name / VERSION
        target = 'core/releases/' + VERSION if name == 'core' else 'integrations/' + name + '/' + VERSION
        for path in folder.rglob('*'):
            if path.is_file():
                files[target + '/' + path.relative_to(folder).as_posix()] = path
    assert all((source / 'core' / name).is_file() for name in ['core', 'platformctl']), 'Missing Core candidate; check build output layout'
    assert (source / 'core/ui/core.html').is_file(), 'Missing Core UI'
    assert all((source / name / VERSION / 'manifest.json').is_file() for name in ['hostings'])
    # Resume an identical staged release after a readiness failure, without
    # overwriting any existing version. All hashes are checked below.
    present = []
    for relative in ['core/releases/' + VERSION, 'integrations/hostings/' + VERSION]:
        if ssh('if test -e ' + shlex.quote(destination + '/' + relative) + '; then echo present; else echo absent; fi').strip() == 'present':
            present.append(relative + '/')
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w:gz') as tar:
        for name, path in files.items():
            if any(name.startswith(prefix) for prefix in present):
                continue
            info = tar.gettarinfo(str(path), arcname=name)
            info.mode = 0o755 if path.name in ['worker', 'core', 'platformctl'] or path.suffix == '.sh' else 0o644
            with path.open('rb') as stream:
                tar.addfile(info, stream)
    ssh('tar -xzf - -C ' + shlex.quote(destination), archive.getvalue())
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    verify = "import pathlib,json,hashlib\nroot=pathlib.Path('/opt/share/homenet')\nexpected=" + repr(hashes) + "\nassert all(hashlib.sha256((root/p).read_bytes()).hexdigest()==h for p,h in expected.items())\nprint('staged hashes verified')\n"
    print(ssh('/opt/bin/python3 -', verify.encode()), flush=True)
    code = r'''
import pathlib,subprocess,json,os,time,shutil,urllib.request
root=pathlib.Path('/opt/share/homenet');state=pathlib.Path('/opt/etc/homenet/core')
current=root/'core/current';old=current.resolve();new=root/'core/releases/VERSION'
registry=json.loads((state/'registry.json').read_text())
listen=json.loads((state/'config.json').read_text())['listen']
ready_url='http://'+listen.replace('0.0.0.0:','127.0.0.1:')+'/health/ready'
assert not any(i['manifest']['id']=='hostings' for i in registry['items']), 'Hostings already installed; use lifecycle update'
previous=[{'id':'hostings','action':'remove'}]
for p in (state/'operations').glob('*.json'):
 op=json.loads(p.read_text());assert op.get('status') not in ['running','recovering','recovery_required'],'Unfinished Core operation'
backup=state/('backup/NPM-120-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
for name in ['config.json','registry.json']:shutil.copy2(state/name,backup/name)
(backup/'old-core').write_text(str(old))
def run(argv):
 p=subprocess.run(argv,capture_output=True,timeout=180)
 if p.returncode:raise RuntimeError('Lifecycle operation failed: '+p.stderr.decode(errors='replace')[-500:])
 return p.stdout.decode()
def activate(path):
 tmp=current.with_name('current.NPM-120');tmp.symlink_to(path);tmp.replace(current)
service='/opt/etc/init.d/S99homenet-core'
run(['sh',service,'stop'])
changed=False
try:
 changes=[{'id':'hostings','action':'install','version':'VERSION'}]
 dry=run([str(new/'platformctl'),'apply','--config',str(state/'config.json'),'--changes',json.dumps(changes),'--dry-run=true'])
 assert json.loads(dry)['status']=='planned',dry
 output=run([str(new/'platformctl'),'apply','--config',str(state/'config.json'),'--changes',json.dumps(changes),'--dry-run=false'])
 assert json.loads(output)['status']=='succeeded',output
 changed=True
 activate(new);run(['sh',service,'start'])
 ready=False
 for i in range(30):
  try:
   with urllib.request.urlopen(ready_url,timeout=5) as r:ready=json.load(r).get('status')=='ready'
  except Exception:pass
  if ready:break
  time.sleep(2)
 assert ready,'Updated Core is not ready'
 print(json.dumps({'core':'VERSION','integrations':['hostings'],'ready':True,'backup':str(backup)}))
except BaseException:
 run(['sh',service,'stop'])
 if changed:
  output=run([str(new/'platformctl'),'apply','--config',str(state/'config.json'),'--changes',json.dumps(previous),'--dry-run=false'])
  assert json.loads(output)['status']=='succeeded',output
 activate(old);run(['sh',service,'start']);raise
'''.replace('VERSION', VERSION)
    print(ssh('/opt/bin/python3 -', code.encode(), timeout=360), flush=True)


if __name__ == '__main__':
    main()
