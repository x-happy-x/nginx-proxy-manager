import builtins
import contextlib
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

import usb_image


class UsbImageTest(unittest.TestCase):
    def setup_images(self, root):
        size=12*1024*1024
        plan={'disk':{'Size':size},'partition':{'Offset':1024*1024,'Size':8*1024*1024}}
        old=root/'before.img';old.write_bytes(bytes(size))
        shutil.copy2(old,root/'after.img');shutil.copy2(old,root/'usb')
        with (root/'after.img').open('r+b') as f:f.seek(1024*1024+4096);f.write(b'HomeNet')
        (root/'backup.json').write_text(json.dumps({'disk':plan['disk']}))
        blocks=[{'offset':p,'length':len(b),'sha256':hashlib.sha256(b).hexdigest()} for p,a,b in usb_image.changes(old,root/'after.img',1024*1024,9*1024*1024)]
        (root/'ready.json').write_text(json.dumps({'schema':1,'lan_ip':'192.168.2.1','blocks':blocks}))
        return plan

    def apply(self,root,plan):
        with mock.patch.object(usb_image,'identity',return_value=str(root/'usb')),mock.patch.object(usb_image,'lock_volume',return_value=contextlib.nullcontext()):
            usb_image.apply(plan,root)

    def test_changed_blocks_are_written_and_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=self.setup_images(root);self.apply(root,plan)
            self.assertEqual((root/'usb').read_bytes(),(root/'after.img').read_bytes())
            self.assertEqual(json.loads((root/'status.json').read_text())['phase'],'done')

    def test_partition_table_changes_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=self.setup_images(root)
            with (root/'after.img').open('r+b') as f:f.write(b'X')
            with self.assertRaisesRegex(RuntimeError,'outside'):self.apply(root,plan)
            self.assertEqual((root/'usb').read_bytes(),(root/'before.img').read_bytes())

    def test_working_image_changed_after_review_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=self.setup_images(root)
            with (root/'after.img').open('r+b') as f:f.seek(1024*1024+4096);f.write(b'Changed')
            with self.assertRaisesRegex(RuntimeError,'after verification'):self.apply(root,plan)
            self.assertEqual((root/'usb').read_bytes(),(root/'before.img').read_bytes())

    def test_usb_changed_after_backup_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=self.setup_images(root)
            with (root/'usb').open('r+b') as f:f.seek(1024*1024);f.write(b'X')
            with self.assertRaisesRegex(RuntimeError,'since backup'):self.apply(root,plan)

    def test_partial_write_failure_restores_original_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan=self.setup_images(root);real_open=builtins.open
            class FailOnce:
                def __init__(self,f):self.f=f;self.failed=False
                def __getattr__(self,k):return getattr(self.f,k)
                def __enter__(self):return self
                def __exit__(self,*args):self.f.close()
                def write(self,data):
                    if not self.failed:
                        self.failed=True;self.f.write(data[:512]);raise OSError('simulated USB failure')
                    return self.f.write(data)
            def open_disk(path,*args,**kwargs):
                f=real_open(path,*args,**kwargs)
                return FailOnce(f) if str(path)==str(root/'usb') and args[0]=='r+b' else f
            with mock.patch('builtins.open',side_effect=open_disk):
                with self.assertRaisesRegex(OSError,'simulated'):self.apply(root,plan)
            self.assertEqual((root/'usb').read_bytes(),(root/'before.img').read_bytes())


if __name__=='__main__':unittest.main()
