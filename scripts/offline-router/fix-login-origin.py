"""Offline, reversible fix for the exact standalone gateway exported in NPM-108."""
import hashlib
import os
from pathlib import Path

BEFORE='a4c6a840922e36f6c9af7baa5d34f86bb789925cfe30e111e26af6d6311ab1fb'
AFTER='abd0593d7223beb43be4a220e302ebb41b619dbd067604da7556b6c7e2079a73'


def fix(path):
    data=path.read_bytes();digest=hashlib.sha256(data).hexdigest()
    if digest==AFTER:return 'Already fixed'
    if digest!=BEFORE or data.count(b'no-referrer')!=1:
        raise RuntimeError('Unexpected gateway version; no files were changed')
    updated=data.replace(b'no-referrer',b'same-origin')
    if len(updated)!=len(data) or hashlib.sha256(updated).hexdigest()!=AFTER:
        raise RuntimeError('Unexpected patch checksum; no files were changed')
    backup=path.with_name(path.name+'.before-NPM114')
    if backup.exists():
        if backup.read_bytes()!=data:raise RuntimeError('Different backup already exists')
    else:
        with backup.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        backup.chmod(path.stat().st_mode & 0o777)
    temporary=path.with_name(path.name+'.NPM114.new')
    with temporary.open('wb') as f:f.write(updated);f.flush();os.fsync(f.fileno())
    temporary.chmod(path.stat().st_mode & 0o777)
    os.replace(temporary,path)
    return 'Fixed; original gateway saved in '+str(backup)


if __name__=='__main__':print(fix(Path('/opt/share/homenet/offline/gateway')))
