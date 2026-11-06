"""Build a private, offline ARM64 transfer bundle from the running source router."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

from common import portable_runtime_env


def extract(stream, destination):
    modes={}
    with tarfile.open(stream, 'r:') as archive:
        for member in archive:
            path=Path(member.name)
            if path.is_absolute() or '..' in path.parts or not member.isfile():
                raise RuntimeError('Unsafe export member')
            target=destination/path
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(member) as src, target.open('wb') as out:shutil.copyfileobj(src,out)
            target.chmod(member.mode & 0o777)
            modes[member.name]=member.mode & 0o777
    return modes


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',default='keenetic');p.add_argument('--go',required=True)
    p.add_argument('--output',type=Path,default=Path('.local/NPM-108'))
    args=p.parse_args();here=Path(__file__).resolve().parent;repo=here.parent.parent
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    folder=output/('build-'+time.strftime('%Y%m%d-%H%M%S'));folder.mkdir()
    bundle=folder/'homenet-vpn-transfer';bundle.mkdir()
    raw=folder/'source.private.tar'
    program=(here/'common.py').read_bytes()+b'\n'+(here/'collect.py').read_bytes()
    with raw.open('wb') as out:
        result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',args.source,
                               '/opt/bin/python3','-'],input=program,stdout=out,stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Source export failed: '+result.stderr.decode(errors='replace')[-1000:])
    modes=extract(raw,bundle);raw.unlink()
    for name in ('install.py','common.py','install.sh','README-install.md'):shutil.copy2(here/name,bundle/name)
    envfile=bundle/'payload/opt/etc/homenet/nginx/config/runtime.env'
    envfile.parent.mkdir(parents=True,exist_ok=True);envfile.write_text(portable_runtime_env(),encoding='utf-8')
    routes=envfile.parent.parent/'routes.yml'
    routes.write_text(json.dumps({'schema_version':'2.1','globals':{'ssl_mode':'local-ca','listen_ips':[],
        'ports':{'http':80,'https':443},'ui':{'host':'127.0.0.1','port':18490}},'apps':[],'hosts':[]}),encoding='utf-8')
    executable=bundle/'payload/opt/share/homenet/offline/front'
    env=os.environ.copy();env.update(GOROOT=str(Path(args.go).resolve().parent.parent),GOTOOLCHAIN='local',GOOS='linux',GOARCH='arm64',CGO_ENABLED='0')
    subprocess.run([args.go,'build','-buildvcs=false','-trimpath','-ldflags=-s -w','-o',str(executable),'./offlinefront'],cwd=repo/'backend',env=env,check=True)
    executable.chmod(0o755)
    modes['payload/opt/share/homenet/offline/front']=0o755
    modes['install.sh']=0o755
    source=json.loads((bundle/'meta/source.json').read_text(encoding='utf-8'))
    files={f.relative_to(bundle).as_posix():hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(bundle.rglob('*')) if f.is_file()}
    (bundle/'MANIFEST.json').write_text(json.dumps({'schema':1,'source':source,'files':files},ensure_ascii=False,indent=2),encoding='utf-8')
    archive=output/('homenet-vpn-transfer-'+time.strftime('%Y%m%d-%H%M%S')+'-arm64.private.tar.gz')
    def permissions(member):
        rel=member.name.removeprefix('homenet-vpn-transfer/')
        # NTFS loses POSIX executable bits; use original remote tar modes.
        member.mode=0o700 if member.isdir() else (0o755 if modes.get(rel,0)&0o111 else 0o600)
        member.uid=member.gid=0;member.uname=member.gname='root'
        return member
    with tarfile.open(archive,'w:gz',compresslevel=6) as tar:
        tar.add(bundle,arcname='homenet-vpn-transfer',recursive=True,filter=permissions)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix+'.sha256').write_text(digest+'  '+archive.name+'\n',encoding='ascii')
    archive.chmod(0o600)
    print(json.dumps({'archive':str(archive),'sha256':digest,'bytes':archive.stat().st_size,'stage':str(bundle),'source':source},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
