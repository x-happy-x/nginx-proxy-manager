import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


loader = importlib.machinery.SourceFileLoader("pve_agent", str(Path(__file__).resolve().parents[1] / "homenet-pve-agent"))
spec = importlib.util.spec_from_loader(loader.name, loader)
agent = importlib.util.module_from_spec(spec)
loader.exec_module(agent)
UPID = "UPID:pve1:00000001:00000002:67100000:qmstart:100:root@pam:"


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.node_patch = patch.object(agent, "NODE", "pve1")
        self.node_patch.start()
        self.addCleanup(self.node_patch.stop)

    def invoke(self, request, argv=()):
        stdout = io.StringIO()
        with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": request}), contextlib.redirect_stdout(stdout):
            code = agent.serve(argv)
        return code, json.loads(stdout.getvalue())

    def test_read_only_default_does_not_call_proxmox(self):
        for request in ("control guest qemu 100 start", "control node reboot"):
            with self.subTest(request=request), patch.object(agent, "pve_request") as api:
                code, result = self.invoke(request)
                self.assertEqual(code, 2)
                self.assertFalse(result["ok"])
                api.assert_not_called()

    def test_capabilities_are_per_key_and_independent(self):
        for argv, guests, node in (((), False, False), (("--allow-guest-actions",), True, False),
                                   (("--allow-node-actions",), False, True)):
            with self.subTest(argv=argv):
                code, result = self.invoke("ping", argv)
                self.assertEqual(code, 0)
                self.assertEqual(result["capabilities"]["control"], guests or node)
                self.assertEqual(bool(result["capabilities"]["guest_actions"]), guests)
                self.assertEqual(bool(result["capabilities"]["node_actions"]), node)
        with patch("builtins.open", side_effect=FileNotFoundError):
            code, result = self.invoke("bundle", ("--allow-guest-actions",))
        self.assertEqual(result["capabilities"]["guest_actions"], list(agent.GUEST_ACTIONS))
        self.assertIsNone(result["current"])

    def test_ssh_text_cannot_grant_permissions(self):
        for request in ("--allow-guest-actions control guest qemu 100 start",
                        "control guest qemu 100 start --allow-guest-actions",
                        "serve --allow-node-actions control node reboot"):
            with self.subTest(request=request), patch.object(agent, "pve_request") as api:
                code, result = self.invoke(request)
                self.assertEqual(code, 2)
                api.assert_not_called()

    def test_guest_permission_does_not_enable_host_actions(self):
        with patch.object(agent, "pve_request") as api:
            code, result = self.invoke("control node reboot", ("--allow-guest-actions",))
        self.assertEqual(code, 2)
        api.assert_not_called()

    def test_injection_and_unknown_operations_never_reach_proxmox(self):
        requests = ["control guest qemu 100;reboot start", "control guest qemu ../100 start",
                    "control guest qemu 0100 start", "control guest qemu 99 start",
                    "control guest qemu 1000000000 start", "control guest qemu -1 start",
                    "control guest lxc ١٠٠ start", "control guest qemu 100 reset",
                    "control guest qemu 100 start --skiplock 1", "control guest ../qemu 100 start",
                    "control node reboot;id", "control node shutdown --force", "control node start",
                    "control guest qemu 100\nstart", "control\tguest qemu 100 start",
                    "control guest qemu 100 start\x00", "a" * 513]
        for request in requests:
            with self.subTest(request=request), patch.object(agent, "pve_request") as api:
                code, result = self.invoke(request, ("--allow-guest-actions", "--allow-node-actions"))
                self.assertEqual(code, 2)
                self.assertFalse(result["ok"])
                api.assert_not_called()

    def test_all_guest_actions_check_live_state_and_return_upid(self):
        for kind in ("qemu", "lxc"):
            for action in agent.GUEST_ACTIONS:
                state = "stopped" if action == "start" else "running"
                with self.subTest(kind=kind, action=action), patch.object(agent, "pve_request", side_effect=[
                        [{"vmid": 100}], {}, {"status": state}, UPID]) as api:
                    result = agent.dispatch_control("control guest %s 100 %s" % (kind, action), True)
                    self.assertEqual(result, {"ok": True, "upid": UPID})
                    self.assertEqual(api.call_args_list, [
                        unittest.mock.call("get", "/nodes/pve1/" + kind),
                        unittest.mock.call("get", "/nodes/pve1/%s/100/config" % kind),
                        unittest.mock.call("get", "/nodes/pve1/%s/100/status/current" % kind),
                        unittest.mock.call("create", "/nodes/pve1/%s/100/status/%s" % (kind, action))])

    def test_missing_or_remote_guest_is_rejected_before_mutation(self):
        for guests in ([], [{"vmid": 101}], None, {}, [None]):
            with self.subTest(guests=guests), patch.object(agent, "pve_request", return_value=guests) as api:
                with self.assertRaisesRegex(agent.RequestError, "does not exist"):
                    agent.control_guest("qemu", "100", "start")
                self.assertEqual(api.call_count, 1)

    def test_templates_locks_and_invalid_state_are_rejected(self):
        cases = [({"template": 1}, {"status": "stopped"}, "start"),
                 ({"lock": "backup"}, {"status": "running"}, "stop"),
                 ({}, {"template": 1, "status": "stopped"}, "start"),
                 ({}, {"lock": "migrate", "status": "running"}, "shutdown"),
                 ({}, {"status": "running"}, "start"), ({}, {"status": "stopped"}, "reboot"),
                 ({}, {"status": "unknown"}, "stop"), ({}, {}, "shutdown"), (None, {}, "start")]
        for config, state, action in cases:
            with self.subTest(config=config, state=state, action=action), patch.object(agent, "pve_request", side_effect=[
                    [{"vmid": 100}], config, state]) as api:
                with self.assertRaises(agent.RequestError):
                    agent.control_guest("lxc", "100", action)
                self.assertTrue(all(call.args[0] == "get" for call in api.call_args_list))

    def test_host_actions_only_acknowledge_acceptance(self):
        for action in agent.NODE_ACTIONS:
            with self.subTest(action=action), patch.object(agent, "pve_request", return_value=None) as api:
                result = agent.dispatch_control("control node " + action, allow_node=True)
                self.assertTrue(result["ok"])
                self.assertNotIn("upid", result)
                api.assert_called_once_with("create", "/nodes/pve1/status", "--command", action)

    def test_guest_accepted_without_task_does_not_invite_retry(self):
        with patch.object(agent, "pve_request", side_effect=[[{"vmid": 100}], {}, {"status": "stopped"}, None]):
            result = agent.control_guest("qemu", "100", "start")
        self.assertTrue(result["ok"])
        self.assertIn("refresh", result["message"])

    def test_tasks_are_read_only_and_keep_failures(self):
        for state in ({"status": "running"}, {"status": "stopped", "exitstatus": "OK"},
                      {"status": "stopped", "exitstatus": "ERROR: guest failed to stop"}):
            with self.subTest(state=state), patch.object(agent, "pve_request", return_value=state) as api:
                result = agent.dispatch_control("task " + UPID)
                self.assertEqual(result, dict(state, ok=True))
                api.assert_called_once_with("get", "/nodes/pve1/tasks/%s/status" % UPID)

    def test_task_id_rejects_foreign_node_paths_and_shell_syntax(self):
        for upid in (UPID.replace("pve1", "pve2"), UPID + ";reboot", UPID + "/../../status",
                     UPID.replace("100:", "../100:"), UPID.replace("00000001", "xyz"), "--help", "x" * 257):
            with self.subTest(upid=upid), patch.object(agent, "pve_request") as api:
                with self.assertRaises(agent.RequestError):
                    agent.dispatch_control("task " + upid)
                api.assert_not_called()

    def test_task_malformed_response_cannot_be_success(self):
        for response in (None, [], {}, {"status": "OK"}):
            with self.subTest(response=response), patch.object(agent, "pve_request", return_value=response):
                with self.assertRaises(agent.RequestError):
                    agent.dispatch_control("task " + UPID)

    def test_subprocess_is_argument_array_without_shell(self):
        result = subprocess.CompletedProcess([], 0, json.dumps(UPID), "")
        with patch.object(agent.subprocess, "run", return_value=result) as run:
            self.assertEqual(agent.pve_request("create", "/nodes/pve1/qemu/100/status/start"), UPID)
        run.assert_called_once_with(["pvesh", "create", "/nodes/pve1/qemu/100/status/start", "--output-format", "json"],
                                    capture_output=True, text=True, timeout=20)

    def test_proxmox_error_is_not_hidden(self):
        result = subprocess.CompletedProcess([], 1, "", "guest is locked\n")
        with patch.object(agent.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(agent.RequestError, "guest is locked"):
                agent.pve_request("create", "/nodes/pve1/qemu/100/status/start")

    def test_timeout_reports_unknown_result_and_does_not_retry(self):
        with patch.object(agent.subprocess, "run", side_effect=subprocess.TimeoutExpired("pvesh", 20)) as run:
            with self.assertRaisesRegex(agent.RequestError, "result is unknown"):
                agent.pve_request("create", "/nodes/pve1/status", "--command", "reboot")
        self.assertEqual(run.call_count, 1)

    def test_ambiguous_mutation_is_reported_as_unknown(self):
        for response in (subprocess.TimeoutExpired("pvesh", 20), subprocess.CompletedProcess([], 0, "truncated", "")):
            kwargs = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
            with self.subTest(response=response), patch.object(agent.subprocess, "run", **kwargs) as run:
                code, result = self.invoke("control node reboot", ("--allow-node-actions",))
                self.assertEqual(code, 0)
                self.assertTrue(result["ok"])
                self.assertTrue(result["unknown"])
                self.assertIn("unknown", result["message"])
                self.assertEqual(run.call_count, 1)

    def test_bad_json_and_missing_pvesh_are_failures(self):
        with patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "not json", "")):
            with self.assertRaisesRegex(agent.RequestError, "Invalid Proxmox response"):
                agent.pve_request("get", "/nodes/pve1/qemu")
        with patch.object(agent.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(agent.RequestError, "Cannot execute"):
                agent.pve_request("get", "/nodes/pve1/qemu")


if __name__ == "__main__":
    unittest.main()
