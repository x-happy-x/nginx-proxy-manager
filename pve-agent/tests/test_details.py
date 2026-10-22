import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
loader = importlib.machinery.SourceFileLoader('pve_details', str(Path(__file__).resolve().parents[1] / 'homenet-pve-agent'))
agent = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(agent)

class DetailsTests(unittest.TestCase):
    def test_only_local_guests_and_allocation(self):
        with patch.object(agent, 'NODE', 's1'), patch.object(agent, 'sh_json', return_value=[
            {'node': 's1', 'vmid': 100, 'maxcpu': 4, 'maxmem': 4096, 'maxdisk': 8192},
            {'node': 's2', 'vmid': 101}, {'vmid': 102}]):
            result = agent.guests()
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0]['cpus'], result[0]['maxmem'], result[0]['maxdisk']), (4, 4096, 8192))

    def test_config_allowlist_and_local_path(self):
        with patch.object(agent, 'NODE', 's1'), patch.object(agent, 'sh_json', return_value={
            'scsi0': 'local-lvm:vm-100-disk-0,size=64G', 'net0': 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0',
            'agent': '1', 'cipassword': 'SECRET', 'sshkeys': 'SECRET'}) as api:
            cfg = agent.guest_config('qemu', 100)
        self.assertIn('/nodes/s1/qemu/100/config', api.call_args.args[0])
        self.assertNotIn('SECRET', str(cfg))
        self.assertEqual(cfg['networks'][0]['mac'], 'bc:24:11:aa:bb:cc')
        self.assertEqual(cfg['disks'][0]['size'], '64G')
        self.assertIsNone(agent.guest_config('../bad', 100))

    def test_cache_refresh_and_failed_source(self):
        a = agent.Agent()
        with patch.object(agent.time, 'time', return_value=100), patch.object(agent, 'guest_config', return_value={'agent': 1}) as source:
            a.every('config:qemu:100', 300, lambda: source('qemu', 100))
            a.every('config:qemu:100', 300, lambda: source('qemu', 100))
            source.assert_called_once()
        with patch.object(agent.time, 'time', return_value=401):
            self.assertEqual(a.every('config:qemu:100', 300, lambda: {'agent': 0}), {'agent': 0})

    def test_backup_window_size_and_job_error(self):
        now = 2000000
        def api(args, *rest):
            if args[2].endswith('/tasks'):
                return [{'id': '100', 'upid': 'task1', 'status': 'OK', 'starttime': now-200, 'endtime': now-100},
                        {'id': '', 'upid': 'job2', 'status': 'ERROR: no space', 'starttime': now-300, 'endtime': now-250},
                        {'id': '100', 'starttime': 1}]
            return [{'vmid': 100, 'ctime': now-180, 'size': 2048, 'volid': 'local:backup/a'},
                    {'vmid': 102, 'ctime': now-400, 'size': 4096, 'volid': 'local:backup/b'}, {'ctime': 1}]
        with patch.object(agent.time, 'time', return_value=now), patch.object(agent, 'sh_json', side_effect=api), patch.object(agent, 'storage', return_value=[{'name': 'local', 'active': True, 'content': 'backup,iso'}]):
            result = agent.backups()
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]['size'], 2048)
        self.assertEqual(result[1]['status'], 'ERROR: no space')
        self.assertIsNone(result[1]['vmid'])
        self.assertEqual(result[2]['vmid'], 102)

    def test_tasks_paginate(self):
        with patch.object(agent.time, 'time', return_value=2000000), patch.object(agent, 'storage', return_value=[]), patch.object(agent, 'sh_json', side_effect=[[{'starttime': 1999000, 'id': str(i)} for i in range(100)], []]) as api:
            self.assertEqual(len(agent.backups()), 100)
            self.assertEqual(api.call_count, 2)
            self.assertIn('--since', api.call_args.args[0])
            self.assertEqual(api.call_args.args[0][api.call_args.args[0].index('--start')+1], '100')

if __name__ == '__main__':
    unittest.main()
