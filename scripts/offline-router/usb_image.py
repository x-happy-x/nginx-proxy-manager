"""Windows raw USB backup and verified changed-block writeback.

Run the backup/apply commands elevated. The target must match the recorded
USB identity; applying never changes partition tables or other disks.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

CHUNK = 4 * 1024 * 1024


def save(path, data):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(data, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def identity(plan):
    number = int(plan['disk']['Number'])
    command = ('Get-Disk -Number ' + str(number) + ' | Select-Object Number,FriendlyName,'
               'SerialNumber,UniqueId,BusType,Size,LogicalSectorSize | ConvertTo-Json -Compress')
    actual = json.loads(subprocess.check_output([plan['powershell'], '-NoProfile', '-Command', command]))
    for key in ('Number', 'FriendlyName', 'SerialNumber', 'UniqueId', 'BusType', 'Size', 'LogicalSectorSize'):
        if actual[key] != plan['disk'][key]:
            raise RuntimeError('USB identity changed: ' + key)
    if actual['BusType'] != 'USB' or not actual['SerialNumber']:
        raise RuntimeError('A uniquely identified USB device is required')
    return r'\\.\PhysicalDrive' + str(number)


def backup(plan, directory):
    device = identity(plan)
    destination = directory / 'before.img'
    temporary = directory / 'before.img.partial'
    if destination.exists() or temporary.exists():
        raise RuntimeError('Backup already exists; refusing to overwrite it')
    size = plan['disk']['Size']; position = 0; digest = hashlib.sha256(); last = 0
    with open(device, 'rb', buffering=0) as source, temporary.open('xb', buffering=0) as output:
        while position < size:
            data = source.read(min(CHUNK, size-position))
            if not data: raise RuntimeError('Unexpected end of USB device')
            output.write(data); digest.update(data); position += len(data)
            if time.monotonic()-last > 2:
                save(directory/'status.json', {'phase':'backup','bytes':position,'size':size})
                last = time.monotonic()
        os.fsync(output.fileno())
    os.replace(temporary, destination)
    save(directory/'backup.json', {'schema':1,'disk':plan['disk'],'bytes':position,
                                  'sha256':digest.hexdigest(),'created':time.time()})
    save(directory/'status.json', {'phase':'backup_done','bytes':position,'size':size})


def changes(before, after, start, end):
    with before.open('rb') as old, after.open('rb') as new:
        old.seek(start); new.seek(start)
        position = start
        while position < end:
            length = min(CHUNK, end-position)
            a, b = old.read(length), new.read(length)
            if len(a) != length or len(b) != length: raise RuntimeError('Image size mismatch')
            if a != b: yield position, a, b
            position += length


@contextlib.contextmanager
def lock_volume(plan):
    """Keep Windows from opening the RAW Entware volume while blocks change."""
    import ctypes
    from ctypes import wintypes
    partition=plan['partition'];letter=partition.get('DriveLetter','')
    if not re_full_drive_letter(letter):raise RuntimeError('Expected a single USB volume drive letter')
    command=('Get-Partition -DiskNumber '+str(int(plan['disk']['Number']))+' -PartitionNumber '+
             str(int(partition['PartitionNumber']))+' | Select-Object Offset,Size,DriveLetter | ConvertTo-Json -Compress')
    actual=json.loads(subprocess.check_output([plan['powershell'],'-NoProfile','-Command',command]))
    if any(actual[k]!=partition[k] for k in ('Offset','Size','DriveLetter')):
        raise RuntimeError('USB partition identity changed')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
    kernel.CreateFileW.restype=wintypes.HANDLE
    kernel.DeviceIoControl.argtypes=[wintypes.HANDLE,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD),ctypes.c_void_p]
    kernel.DeviceIoControl.restype=wintypes.BOOL
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    path='\\\\.\\'+letter+':'
    handle=kernel.CreateFileW(path,0xC0000000,3,None,3,0,None)
    if handle==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    try:
        returned=wintypes.DWORD()
        for control in (0x90018,0x90020): # FSCTL_LOCK_VOLUME, FSCTL_DISMOUNT_VOLUME
            if not kernel.DeviceIoControl(handle,control,None,0,None,0,ctypes.byref(returned),None):
                raise ctypes.WinError(ctypes.get_last_error())
        yield
    finally:kernel.CloseHandle(handle)


def re_full_drive_letter(value):
    return isinstance(value,str) and len(value)==1 and 'A'<=value<='Z'


def apply(plan, directory):
    device = identity(plan)
    before, after = directory/'before.img', directory/'after.img'
    record = json.loads((directory/'backup.json').read_text())
    size = plan['disk']['Size']
    if record['disk'] != plan['disk'] or before.stat().st_size != size or after.stat().st_size != size:
        raise RuntimeError('Backup or working image does not match this USB')
    # Only the Entware partition may change; GPT, the other partition and gaps stay exact.
    start, length = plan['partition']['Offset'], plan['partition']['Size']
    end = start+length
    if start % 512 or length % 512 or not (1024*1024 <= start < end < size):
        raise RuntimeError('Invalid Entware partition bounds')
    for left, right in ((0,start),(end,size)):
        if next(changes(before,after,left,right),None) is not None:
            raise RuntimeError('Working image changed outside the Entware partition')
    expected = json.loads((directory/'ready.json').read_text())
    if expected.get('schema') != 1 or expected.get('lan_ip') != '192.168.2.1':
        raise RuntimeError('Missing verified installation record')
    # First pass validates every changed block against both the USB and reviewed manifest.
    index = []
    with open(device,'rb',buffering=0) as disk:
        for position,a,b in changes(before,after,start,end):
            disk.seek(position)
            if disk.read(len(a)) != a: raise RuntimeError('USB contents changed since backup')
            index.append({'offset':position,'length':len(b),'sha256':hashlib.sha256(b).hexdigest()})
    if index != expected['blocks'] or not index:
        raise RuntimeError('Working image changed after verification')
    written = []; total = sum(i['length'] for i in index); done = 0
    with lock_volume(plan), open(device,'r+b',buffering=0) as disk:
        try:
            for position,a,b in changes(before,after,start,end):
                # Recheck immediately before writing. Rollback includes partially written blocks.
                disk.seek(position)
                if disk.read(len(a)) != a: raise RuntimeError('USB block changed before write')
                written.append((position,len(a))); disk.seek(position)
                if disk.write(b) != len(b): raise RuntimeError('Short USB write')
                done += len(b)
                save(directory/'status.json', {'phase':'writeback','bytes':done,'size':total})
            os.fsync(disk.fileno())
            for entry in index:
                disk.seek(entry['offset'])
                if hashlib.sha256(disk.read(entry['length'])).hexdigest() != entry['sha256']:
                    raise RuntimeError('USB verification failed')
        except BaseException:
            with before.open('rb') as original:
                for position,length in reversed(written):
                    original.seek(position); disk.seek(position); disk.write(original.read(length))
            os.fsync(disk.fileno())
            raise
    save(directory/'status.json', {'phase':'done','bytes':done,'size':total,'verified_blocks':len(index)})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','apply'])
    parser.add_argument('--plan',type=Path,required=True)
    args=parser.parse_args(); plan=json.loads(args.plan.read_text(encoding='utf-8-sig'))
    directory=args.plan.resolve().parent
    try:
        (backup if args.action=='backup' else apply)(plan,directory)
    except BaseException as error:
        save(directory/'status.json',{'phase':'error','action':args.action,'error':str(error)})
        raise


if __name__=='__main__':main()
