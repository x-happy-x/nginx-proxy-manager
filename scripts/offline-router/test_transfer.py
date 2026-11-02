import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from common import without_tail, without_tail_state, provider_path

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


def manifest(bundle):
    files={p.relative_to(bundle).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.rglob('*') if p.is_file() and p.name!='MANIFEST.json'}
    (bundle/'MANIFEST.json').write_text(json.dumps({'files':files,'source':{'core_version':'test'}}))


class TransferTest(unittest.TestCase):
    def test_source_router_is_refused_before_any_install(self):
        with mock.patch.object(installer,'verify',return_value={'source':{'source_mac':'source'}}), \
             mock.patch.object(installer,'discover_ip',return_value='192.0.2.1'), \
             mock.patch.object(installer.os,'geteuid',return_value=0,create=True), \
             mock.patch.object(installer.platform,'machine',return_value='aarch64'), \
             mock.patch.object(Path,'read_text',return_value='source'), \
             mock.patch.object(installer.sys,'argv',['install.py','--apply']), \
             mock.patch.object(installer,'install') as apply:
            with self.assertRaisesRegex(RuntimeError,'source router'):installer.main()
            apply.assert_not_called()
    def test_tail_cascade_removed_and_original_untouched(self):
        original={'proxies':[{'name':'tail','type':'tailscale'},{'name':'OLC','type':'socks5'}],
          'proxy-groups':[{'name':'tail-group','proxies':['tail']},{'name':'mixed','proxies':['tail-group','OLC']}],
          'rules':['DOMAIN,corp.test,tail-group','MATCH,mixed'],'dns':{'nameserver':['tailscale://tail','https://dns.example/dns-query']}}
        cfg,removed=without_tail(original)
        self.assertEqual(removed,['tail','tail-group']);self.assertEqual(cfg['proxy-groups'][0]['proxies'],['OLC'])
        self.assertEqual(cfg['rules'],['MATCH,mixed']);self.assertEqual(len(original['proxies']),2)
        self.assertEqual(cfg['dns']['nameserver'],['https://dns.example/dns-query'])
        self.assertEqual(without_tail_state({'access':{'tail':['a'],'OLC':['b']}},set(removed)),{'access':{'OLC':['b']}})

    def test_provider_escape_rejected(self):
        self.assertEqual(provider_path('./olcrtc.yaml'),'/opt/etc/mihomo/olcrtc.yaml')
        with self.assertRaises(ValueError):provider_path('../secret')

    def test_manifest_tamper_and_unlisted_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);(b/'install.sh').write_text('test');manifest(b);installer.verify(b)
            (b/'install.sh').write_text('tamper')
            with self.assertRaises(RuntimeError):installer.verify(b)
            manifest(b);(b/'extra').write_text('extra')
            with self.assertRaises(RuntimeError):installer.verify(b)

    def test_backup_refuses_arbitrary_service_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);(b/'backup.json').write_text(json.dumps({'schema':1,'roots':['etc'],'service_roots':['etc']}))
            with self.assertRaises(RuntimeError):installer.restore(b/'target',b)

    def test_install_and_rollback_preserve_old_router(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);bundle=root/'bundle';target=root/'target';bundle.mkdir();target.mkdir()
            def put(base,relative,text):
                p=base/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);return p
            put(target,'opt/etc/mihomo/config.yaml','oldconfig')
            put(target,'opt/share/zashboard/index.html','old dashboard')
            put(target,'opt/etc/init.d/S50mihomo','old service')
            put(target,'opt/root/.ssh/authorized_keys','target-key\n')
            put(bundle,'payload/opt/root/.ssh/authorized_keys','source-key\n')
            put(bundle,'payload/opt/etc/mihomo/config.yaml','{}')
            put(bundle,'payload/opt/etc/homenet/nginx/config/runtime.env','MIHOMO_CONFIG=x\n')
            put(bundle,'payload/opt/share/homenet/core/releases/test/core','binary')
            put(bundle,'meta/registry.json','{"schema":1,"items":[]}');manifest(bundle)
            backup=installer.install(bundle,target,'192.0.2.1',63412,sandbox=True)
            self.assertFalse((target/'opt/share/zashboard').exists())
            self.assertEqual((target/'opt/root/.ssh/authorized_keys').read_text(),'target-key\nsource-key\n')
            installer.restore(target,backup)
            self.assertEqual((target/'opt/etc/mihomo/config.yaml').read_text(),'oldconfig')
            self.assertEqual((target/'opt/root/.ssh/authorized_keys').read_text(),'target-key\n')
            self.assertEqual((target/'opt/share/zashboard/index.html').read_text(),'old dashboard')


if __name__=='__main__':unittest.main()
