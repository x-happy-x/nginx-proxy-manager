"""Exercise remote setup failures in a temporary filesystem, without SSH/ACME."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

if sys.platform == "win32":
    # Unix flock is exercised on the real target; filesystem transaction tests
    # remain runnable on Windows without weakening the production lock.
    sys.modules.setdefault("fcntl", Mock(LOCK_EX=1, LOCK_NB=2))
source = Path(__file__).resolve().parents[2] / "backend/manager/public_provision.py"
spec = importlib.util.spec_from_file_location("public_provision", source)
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class PublicProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.payload = {"id": "vps", "address": "203.0.113.79", "email": "", "key": "ssh-ed25519 fixture", "forwards": [{"host": "app.example", "port": 0}]}
        self.conf = self.root / "etc/nginx/conf.d/homenet-public-vps.conf"
        self.before = "# Managed by HomeNet public servers: vps\n# Previous routes\n"
        self.conf.parent.mkdir(parents=True)
        self.conf.write_text(self.before)
        self.calls = []
        self.fail_certificate = False

        def rooted(path):
            p = Path(path)
            if (p.is_absolute() or str(p).startswith(("/", "\\"))) and not str(p).startswith(str(self.root)):
                return self.root / str(p).replace("\\", "/").lstrip("/")
            return p

        self.addCleanup(patch.stopall)
        patch.object(provision, "Path", rooted).start()
        patch.object(provision.os, "geteuid", return_value=0, create=True).start()
        patch.object(provision.signal, "SIGHUP", 1, create=True).start()
        patch.object(provision.signal, "signal").start()
        patch.object(provision.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("203.0.113.79", 0))]).start()

        def run(*args):
            self.calls.append(args)
            if args == ("nginx", "-T"):
                return "# configuration file /etc/nginx/nginx.conf:\n# configuration file /etc/nginx/conf.d/homenet-public-vps.conf:\n" + (self.conf.read_text() if self.conf.exists() else "")
            if args[0] == "id":
                if not (self.root / "var/lib/homenet-public/servers/vps/user-owned").exists():
                    raise subprocess.CalledProcessError(1, args)
            if args[:2] == ("/usr/sbin/sshd", "-T"):
                return "allowtcpforwarding remote\nmaxsessions 0\ngatewayports no\n"
            if args[0] == "certbot":
                if self.fail_certificate:
                    raise subprocess.CalledProcessError(1, args, "ACME failed")
                cert = rooted(provision.certificate("vps", "app.example"))
                cert.mkdir(parents=True)
                (cert / "fullchain.pem").write_text("certificate")
                (cert / "privkey.pem").write_text("key")
            return ""

        patch.object(provision, "run", side_effect=run).start()

    def test_certificate_failure_restores_previous_vhost(self):
        self.fail_certificate = True
        with self.assertRaises(subprocess.CalledProcessError):
            provision.main(self.payload)
        self.assertEqual(self.conf.read_text(), self.before)
        self.assertFalse((self.root / "var/lib/homenet-public/servers/vps/transaction.json").exists())
        self.assertIn(("systemctl", "reload", "nginx"), self.calls)

    def test_success_installs_restricted_tunnel_and_removes_owned_routes(self):
        provision.main(self.payload)
        self.assertIn("proxy_pass http://127.0.0.1:0;", self.conf.read_text())
        sshd = self.root / "etc/ssh/sshd_config.d/homenet-public-vps.conf"
        self.assertIn("ClientAliveCountMax 3", sshd.read_text())
        self.assertIn("AllowTcpForwarding remote", sshd.read_text())
        self.payload["forwards"] = []
        provision.main(self.payload)
        self.assertFalse(self.conf.exists())
        self.assertFalse(sshd.exists())

    def test_foreign_vhost_is_never_overwritten(self):
        self.conf.write_text("# Someone else's configuration\n")
        with self.assertRaisesRegex(RuntimeError, "Foreign file"):
            provision.main(self.payload)
        self.assertEqual(self.conf.read_text(), "# Someone else's configuration\n")

    def test_pending_journal_is_recovered_before_new_setup(self):
        state = self.root / "var/lib/homenet-public/servers/vps"
        state.mkdir(parents=True)
        sshd = str(self.root / "etc/ssh/sshd_config.d/homenet-public-vps.conf")
        keys = str(self.root / "home/homenet-tunnel-vps/.ssh/authorized_keys")
        (state / "transaction.json").write_text(json.dumps({str(self.conf): self.before, sshd: None, keys: None, "nginx": True, "ssh": True}))
        self.conf.write_text("interrupted candidate")
        self.fail_certificate = True
        with self.assertRaises(subprocess.CalledProcessError):
            provision.main(self.payload)
        self.assertEqual(self.conf.read_text(), self.before)

    def test_conflicting_dns_and_existing_wildcards_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            provision.check_domains(self.payload, "server_name *.example;\n", self.conf)
        provision.socket.getaddrinfo.side_effect = [[(2, 1, 6, "", ("203.0.113.79", 0))], [(2, 1, 6, "", ("192.0.2.1", 0))]]
        with self.assertRaisesRegex(RuntimeError, "DNS"):
            provision.check_domains(self.payload, "", self.conf)


if __name__ == "__main__":
    unittest.main()
