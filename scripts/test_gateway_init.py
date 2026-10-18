"""Linux regression checks: python3 scripts/test_gateway_init.py."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.path.isdir('/proc/self'), 'requires Linux procfs')
class GatewayInitTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.pid = root / 'gateway.pid'
        config = root / 'gateway.json'
        config.write_text('{}')
        self.config = config
        shutil.copyfile(shutil.which('sleep'), root / 'sleep')
        (root / 'sleep').chmod(0o700)
        (root / 'gateway').symlink_to(root / 'sleep')
        # A real executable gives /proc/<pid>/exe the same identity as production.
        # Only the launch arguments are adapted for the harmless sleep process.
        launcher = root / 'nohup'
        launcher.write_text('#!/bin/sh\n[ "$TEST_FAIL_GATEWAY" != 1 ] || exit 1\nexec "$(readlink -f "$1")" 60 </dev/null\n')
        launcher.chmod(0o700)
        self.env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                        HOME_NET_APP_DIR=str(root), HOME_NET_BIN_DIR=str(root),
                        HOME_NET_GATEWAY_PID=str(self.pid),
                        HOME_NET_GATEWAY_CONFIG=str(config),
                        HOME_NET_GATEWAY_LOG=str(root / 'gateway.log'))
        self.script = Path(__file__).resolve().parents[1] / 'init.d/S98homenet-gateway'
        self.foreign = subprocess.Popen(['sleep', '60'])
        self.addCleanup(self.cleanup_processes)

    def cleanup_processes(self):
        if self.pid.exists():
            try:
                pid = int(self.pid.read_text())
                if pid > 0 and os.readlink(f'/proc/{pid}/exe') == self.env['HOME_NET_BIN_DIR'] + '/sleep':
                    os.kill(pid, signal.SIGTERM)
            except (ValueError, OSError):
                pass
        self.foreign.terminate()
        self.foreign.wait(timeout=5)

    def run_init(self, action, success=True):
        result = subprocess.run(['sh', str(self.script), action], env=self.env,
                                capture_output=True, text=True, timeout=15)
        log = Path(self.env['HOME_NET_GATEWAY_LOG'])
        self.assertEqual(result.returncode == 0, success,
                         result.stdout + result.stderr + (log.read_text() if log.exists() else ''))
        self.assertIsNone(self.foreign.poll(), 'init signalled an unrelated process')
        return result

    def stale_pid(self):
        self.pid.write_text(str(self.foreign.pid))

    def test_start_replaces_foreign_pid_and_is_idempotent(self):
        self.stale_pid()
        self.run_init('start')
        pid = int(self.pid.read_text())
        self.assertNotEqual(pid, self.foreign.pid)
        self.run_init('start')
        self.assertEqual(int(self.pid.read_text()), pid)
        self.run_init('stop')
        self.assertFalse(self.pid.exists())
        self.assertFalse(Path(f'/proc/{pid}/exe').exists())

    def test_stop_removes_foreign_or_invalid_pid_without_signalling(self):
        for value in [str(self.foreign.pid), '0', '-1', 'invalid', '']:
            with self.subTest(pid=value):
                self.pid.write_text(value)
                self.run_init('stop')
                self.assertFalse(self.pid.exists())

    def test_restart_with_foreign_pid_starts_gateway(self):
        self.stale_pid()
        self.run_init('restart')
        self.assertNotEqual(int(self.pid.read_text()), self.foreign.pid)
        self.run_init('stop')

    def test_start_failure_is_reported_and_pid_removed(self):
        self.stale_pid()
        self.env['TEST_FAIL_GATEWAY'] = '1'
        result = self.run_init('start', success=False)
        self.assertIn('failed to start', result.stderr)
        self.assertFalse(self.pid.exists())

    def test_missing_config_is_reported(self):
        self.stale_pid()
        self.config.unlink()
        self.run_init('start', success=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
