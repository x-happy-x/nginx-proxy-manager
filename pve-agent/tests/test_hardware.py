import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('pve_hardware', str(Path(__file__).resolve().parents[1] / 'homenet-pve-agent'))
agent = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(agent)


class HardwareTests(unittest.TestCase):
    def test_sysfs_retains_pci_and_usb_without_id_database(self):
        def paths(pattern):
            return {'/sys/bus/pci/devices/*': ['/sys/bus/pci/devices/0000:04:00.0'],
                    '/sys/bus/usb/devices/*': ['/sys/bus/usb/devices/1-2']}.get(pattern, [])
        def read(path, default=''):
            return {'vendor': '0xffff', 'device': '0x0001', 'class': '0x020000',
                    'idVendor': 'abcd', 'idProduct': '1234', 'product': 'Custom USB board'}.get(path.rsplit('/', 1)[-1], default)
        with patch.object(agent, 'sh', return_value=''), patch.object(agent.glob, 'glob', side_effect=paths), patch.object(agent, 'read', side_effect=read), patch.object(agent.os.path, 'islink', return_value=False):
            rows = agent.hardware_devices()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['id'], 'pci:0000:04:00.0')
        self.assertEqual(rows[0]['status'], 'unrecognized')
        self.assertEqual(rows[0]['vendor_id'], 'ffff')
        self.assertEqual(rows[1]['name'], 'Custom USB board')

    def test_unknown_pci_model_keeps_class_and_driver(self):
        pci = 'Slot:\t0000:04:00.0\nClass:\tEthernet controller [0200]\nVendor:\tDevice [ffff]\nDevice:\tDevice [0001]\nDriver:\ttest_driver\n'
        with patch.object(agent, 'sh', return_value=pci), patch.object(agent.glob, 'glob', side_effect=lambda pattern: ['/sys/bus/pci/devices/0000:04:00.0'] if pattern == '/sys/bus/pci/devices/*' else []), patch.object(agent, 'read', return_value='0xffff'), patch.object(agent.os.path, 'islink', return_value=True), patch.object(agent.os.path, 'realpath', return_value='/sys/bus/pci/drivers/test_driver'):
            row = agent.hardware_devices()[0]
        self.assertEqual(row['name'], '')
        self.assertEqual(row['kind'], 'Ethernet controller')
        self.assertEqual(row['driver'], 'test_driver')
        self.assertEqual(row['raw']['Device'], 'Device [0001]')


if __name__ == '__main__':
    unittest.main()
