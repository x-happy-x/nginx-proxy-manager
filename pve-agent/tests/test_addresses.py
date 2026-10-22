import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


loader = importlib.machinery.SourceFileLoader("pve_agent_addr", str(Path(__file__).resolve().parents[1] / "homenet-pve-agent"))
spec = importlib.util.spec_from_loader(loader.name, loader)
agent = importlib.util.module_from_spec(spec)
loader.exec_module(agent)


class AddressTests(unittest.TestCase):
    """NPM-84: guest IPs come from the guest agent, Docker bridges are ignored."""

    def setUp(self):
        p = patch.object(agent, "NODE", "pve1")
        p.start()
        self.addCleanup(p.stop)

    def test_qemu_guest_agent(self):
        reply = {"result": [
            {"name": "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "127.0.0.1"}]},
            {"name": "eth0", "hardware-address": "BC:24:11:20:6B:CB", "ip-addresses": [
                {"ip-address-type": "ipv4", "ip-address": "192.168.99.33"}, {"ip-address-type": "ipv6", "ip-address": "fe80::1"}]},
            {"name": "docker0", "hardware-address": "02:42:00:00:00:01", "ip-addresses": [{"ip-address-type": "ipv4", "ip-address": "172.17.0.1"}]},
        ]}
        with patch.object(agent, "sh_json", return_value=reply) as api:
            got = agent.guest_net("qemu", 101)
        self.assertEqual(got, {"ips": ["192.168.99.33"], "macs": ["bc:24:11:20:6b:cb"]})
        self.assertIn("/nodes/pve1/qemu/101/agent/network-get-interfaces", api.call_args[0][0])

    def test_qemu_without_agent_falls_back_to_config_macs(self):
        def fake(args, *rest):
            return {"net0": "virtio=BC:24:11:AA:E1:C6,bridge=vmbr0", "name": "x"} if args[2].endswith("/config") else {}
        with patch.object(agent, "sh_json", side_effect=fake):
            self.assertEqual(agent.guest_net("qemu", 100), {"ips": [], "macs": ["bc:24:11:aa:e1:c6"]})

    def test_lxc_interfaces(self):
        reply = [{"name": "lo", "inet": "127.0.0.1/8"}, {"name": "eth0", "inet": "192.168.99.40/24", "hwaddr": "BC:24:11:00:00:01"}]
        with patch.object(agent, "sh_json", return_value=reply):
            self.assertEqual(agent.guest_net("lxc", 300), {"ips": ["192.168.99.40"], "macs": ["bc:24:11:00:00:01"]})

    def test_only_running_guests_are_asked(self):
        listed = [{"vmid": 1, "type": "qemu", "status": "stopped", "template": False},
                  {"vmid": 2, "type": "qemu", "status": "running", "template": False}]
        with patch.object(agent, "guest_net", return_value={"ips": [], "macs": []}) as net:
            self.assertEqual(list(agent.guest_addresses(listed)), ["2"])
        net.assert_called_once_with("qemu", 2)


if __name__ == "__main__":
    unittest.main()
