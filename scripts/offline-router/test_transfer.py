import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from common import without_tail, without_tail_state, provider_path, runtime_script, runtime_binary_name, transfer_integrations

spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


def manifest(bundle):
    files={p.relative_to(bundle).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.rglob('*') if p.is_file() and p.name!='MANIFEST.json'}
    (bundle/'MANIFEST.json').write_text(json.dumps({'files':files,'source':{'core_version':'test'}}))


class TransferTest(unittest.TestCase):
    def test_vpn_transfer_includes_required_analyzer_integration(self):
        source={'items':[{'manifest':{'id':id},'enabled':True} for id in ('vpn','proxy','network')]}
        exported=transfer_integrations(source)
        self.assertEqual([i['manifest']['id'] for i in exported['items']],['vpn','network'])
        source['items'][2]['enabled']=False
        self.assertTrue(exported['items'][1]['enabled'])
        with self.assertRaisesRegex(RuntimeError,'network'):transfer_integrations(source)

    def test_iproute_binary_keeps_plain_ip_basename(self):
        self.assertEqual(runtime_binary_name('ip','/opt/sbin/ip-full'),'ip')
        self.assertEqual(runtime_binary_name('iptables','/opt/sbin/xtables-multi'),'xtables-multi')

    def test_controller_check_waits_for_xkeen_background_start(self):
        response=mock.MagicMock();response.__enter__.return_value.status=200
        with mock.patch.object(installer.urllib.request,'urlopen',side_effect=[OSError('not listening yet'),response]) as opened, \
             mock.patch.object(installer.time,'sleep') as sleep:
            installer.wait_for_mihomo('test-secret')
            self.assertEqual(opened.call_count,2);sleep.assert_called_once_with(1)

    def test_controller_failure_times_out(self):
        with mock.patch.object(installer.urllib.request,'urlopen',side_effect=OSError('not listening')), \
             mock.patch.object(installer.time,'monotonic',side_effect=[0,121]):
            with self.assertRaisesRegex(RuntimeError,'cold start'):installer.wait_for_mihomo('test-secret')
    def test_generated_xkeen_hooks_keep_private_tools_and_patch_is_idempotent(self):
        original=b'#!/bin/sh\ncat > hook <<\'EOF\'\n#!/bin/sh\nPATH="/opt/bin:/bin"\nEOF\n'
        patched=runtime_script(original)
        self.assertEqual(patched.count(b'HOMENET_RUNTIME=/opt/share/homenet/offline-runtime'),2)
        self.assertEqual(runtime_script(patched),patched)

    @unittest.skipUnless(os.name=='posix','POSIX boot shell verification')
    def test_clock_floor_updates_only_a_stale_clock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);service=root/'opt/etc/init.d/S05xkeen';service.parent.mkdir(parents=True);service.write_text('#!/bin/sh\n')
            installer.prepare_boot(root)
            runtime=root/'runtime';(runtime/'bin').mkdir(parents=True)
            marker=root/'date-set';date=runtime/'bin/date'
            date.write_text('#!/bin/sh\nif [ "$1" = +%s ]; then echo "$FAKE_NOW"; else echo "$*" >> "$DATE_MARKER"; fi\n');date.chmod(0o755)
            clock=root/'opt/etc/init.d/S04homenet-clock'
            clock.write_text(clock.read_text().replace('/opt/share/homenet/offline-runtime',str(runtime)))
            env=os.environ.copy();env.update(FAKE_NOW='9999999999',DATE_MARKER=str(marker))
            subprocess.run(['sh',str(clock),'start'],env=env,check=True);self.assertFalse(marker.exists())
            env['FAKE_NOW']='0';subprocess.run(['sh',str(clock),'start'],env=env,check=True)
            self.assertIn('-u -s @',marker.read_text())

    def test_offline_prepare_refuses_host_root(self):
        with mock.patch.object(installer,'verify',return_value={'source':{}}):
            with self.assertRaisesRegex(RuntimeError,'separate mounted'):installer.install(Path('.'),Path('/'),'192.168.2.1',63412,offline=True)
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
            put(target,'opt/etc/init.d/S99nginx-manager-lite','legacy manager')
            put(target,'opt/root/.ssh/authorized_keys','target-key\n')
            put(bundle,'payload/opt/root/.ssh/authorized_keys','source-key\n')
            put(bundle,'payload/opt/etc/mihomo/config.yaml','{}')
            put(bundle,'payload/opt/etc/homenet/nginx/config/runtime.env','MIHOMO_CONFIG=x\n')
            put(bundle,'payload/opt/share/homenet/core/releases/test/core','binary')
            put(bundle,'meta/registry.json','{"schema":1,"items":[]}');manifest(bundle)
            backup=installer.install(bundle,target,'192.0.2.1',63412,sandbox=True)
            gateway=json.loads((target/'opt/etc/homenet/offline/gateway.json').read_text())
            self.assertEqual(gateway['router_url'],'http://192.0.2.1:80')
            self.assertFalse((target/'opt/share/zashboard').exists())
            self.assertFalse((target/'opt/etc/init.d/S99nginx-manager-lite').exists())
            self.assertEqual((target/'opt/root/.ssh/authorized_keys').read_text(),'target-key\nsource-key\n')
            installer.restore(target,backup)
            self.assertEqual((target/'opt/etc/mihomo/config.yaml').read_text(),'oldconfig')
            self.assertEqual((target/'opt/root/.ssh/authorized_keys').read_text(),'target-key\n')
            self.assertEqual((target/'opt/share/zashboard/index.html').read_text(),'old dashboard')
            self.assertEqual((target/'opt/etc/init.d/S99nginx-manager-lite').read_text(),'legacy manager')


if __name__=='__main__':unittest.main()
