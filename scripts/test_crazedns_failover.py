import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("failover", Path(__file__).with_name("crazedns-failover.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FailoverTests(unittest.TestCase):
    candidates = ["DIRECT", "OLC", "backup"]

    def test_confirmed_outage_and_delayed_priority_recovery(self):
        state = {"selected": "OLC", "changed_at": 0}
        for now in [0, 30]:
            self.assertEqual(module.decision(state, self.candidates,
                {"DIRECT": False, "OLC": True, "backup": True}, now), "OLC")
        # One failed check does not drop the channel.
        self.assertEqual(module.decision(state, self.candidates,
            {"DIRECT": False, "OLC": False, "backup": True}, 60), "OLC")
        self.assertEqual(module.decision(state, self.candidates,
            {"DIRECT": False, "OLC": False, "backup": True}, 90), "backup")
        state.update(selected="backup", changed_at=90)
        for now in [120, 150, 180]:
            self.assertEqual(module.decision(state, self.candidates,
                dict.fromkeys(self.candidates, True), now), "backup")
        self.assertEqual(module.decision(state, self.candidates,
            dict.fromkeys(self.candidates, True), 210), "DIRECT")

    def test_total_outage_does_not_rotate_dead_channels(self):
        state = {"selected": "OLC", "changed_at": 0}
        for now in [0, 30, 60, 180]:
            self.assertEqual(module.decision(state, self.candidates,
                dict.fromkeys(self.candidates, False), now), "OLC")

    def test_cleanup_is_limited_to_own_cloud_sessions(self):
        deleted = []
        def connection(ident, ip, port, network, chains):
            return {"id": ident, "metadata": {"destinationIP": ip, "destinationPort": port,
                    "network": network}, "chains": chains}
        connections = [connection("udp", "185.162.93.96", "9", "udp", ["OLC", "CrazyDNS"]),
            connection("tcp", "185.162.93.96", "8090", "tcp", ["OLC", "CrazyDNS"]),
            connection("web", "185.162.93.96", "443", "tcp", ["OLC", "CrazyDNS"]),
            connection("other-group", "185.162.93.96", "8090", "tcp", ["OLC"]),
            connection("other-ip", "8.8.8.8", "9", "udp", ["CrazyDNS"])]
        controller = module.Controller({"group": "CrazyDNS", "cloud_ips": ["185.162.93.96"]})
        def call(path, method="GET", body=None):
            if method == "DELETE": deleted.append(path); return {}
            return {"connections": connections}
        controller.call = call
        self.assertEqual(controller.close_cloud_connections(), 2)
        self.assertEqual(deleted, ["/connections/udp", "/connections/tcp"])

    def test_udp_silence_disqualifies_http_healthy_route(self):
        config = {"group": "CrazyDNS", "candidates": self.candidates, "cloud_ips": ["185.162.93.96"],
            "udp_grace_seconds": 60, "udp_timeout_seconds": 75, "udp_cooldown_seconds": 300,
            "fail_after": 2, "recover_after": 3, "return_hold_seconds": 120}
        class Fake:
            selected = "DIRECT"
            def call(self, path, method="GET", body=None):
                if method == "PUT": self.selected = body["name"]; return {}
                if path == "/connections": return {"connections": []}
                return {"proxies": {"CrazyDNS": {"type": "Selector", "all": config["candidates"], "now": self.selected}}}
            def health(self): return dict.fromkeys(config["candidates"], True), {}
            def close_cloud_connections(self): return 0
        state = {"selected": "DIRECT", "changed_at": 0, "route": ["DIRECT"], "udp_last_rx_at": 0,
                 "counters": {n: {"ok": 3, "fail": 0} for n in self.candidates}}
        fake = Fake()
        module.cycle(config, fake, state, 80)
        self.assertEqual(fake.selected, "DIRECT")
        module.cycle(config, fake, state, 110)
        self.assertEqual(fake.selected, "OLC")
        self.assertGreater(state["blocked_until"]["DIRECT"], 110)


if __name__ == "__main__":
    unittest.main()
