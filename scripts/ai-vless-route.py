#!/usr/bin/env python3
"""NPM-119: run on router, apply VLESS nodes, then guarded AI cutover."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = pathlib.Path('/opt/etc/mihomo/recovery-NPM-119-vless-20261109')
CONFIG = pathlib.Path('/opt/etc/mihomo/config.yaml')
CLIENT = pathlib.Path('/opt/etc/homenet/mihomo/ai-vless.json')
SELECTOR = 'ИИ · сервер'
SERVER_GROUP = 'ИИ · KZ 38.180.37.198'
ENTRANCE = 'ИИ · вход каскада'
DIRECT = 'VLESS KZ · напрямую'
CHAIN = 'VLESS KZ · каскад'
NAMES = (ENTRANCE, SERVER_GROUP, SELECTOR)


def transform(original, client, activate=False):
    cfg = copy.deepcopy(original)
    by_name = {g['name']: g for g in cfg['proxy-groups']}
    assert 'ИИ' in by_name and 'Обходы' in by_name
    assert client['server'] == '38.180.37.198' and client['port'] == 443
    node = {k: client[k] for k in ('server', 'port', 'uuid', 'servername', 'client-fingerprint')}
    node.update({'type': 'vless', 'tls': True, 'network': 'tcp', 'flow': 'xtls-rprx-vision', 'udp': True, 'packet-encoding': 'xudp',
                 'reality-opts': {**{k: client[k] for k in ('public-key', 'short-id')}, 'support-x25519mlkem768': True}})
    proxies = [p for p in cfg.get('proxies', []) if p['name'] not in (DIRECT, CHAIN)]
    proxies.extend([{**node, 'name': DIRECT, 'dialer-proxy': 'DIRECT'}, {**node, 'name': CHAIN, 'dialer-proxy': ENTRANCE}])
    cfg['proxies'] = proxies
    sources = list(by_name['ИИ'].get('use', []))
    entrance_sources = [name for name in sources if name != 'olcrtc']
    groups = [g for g in cfg['proxy-groups'] if g['name'] not in NAMES]
    additions = [
        {'name': ENTRANCE, 'type': 'select', 'proxies': [n for n in ('Обходы', 'RU', 'AUTO') if n in by_name] + ['DIRECT'], 'use': entrance_sources},
        {'name': SERVER_GROUP, 'type': 'fallback', 'proxies': [CHAIN, DIRECT], 'url': 'https://www.gstatic.com/generate_204', 'interval': 120, 'timeout': 12000, 'lazy': False},
        {'name': SELECTOR, 'type': 'select', 'proxies': [SERVER_GROUP, CHAIN, DIRECT] + [n for n in ('ИИ', 'ИИ прямые', 'ИИ обходы', 'OLCRTC') if n in by_name] + ['REJECT'], 'use': sources},
    ]
    at = next(i for i, g in enumerate(groups) if g['name'] == 'ИИ') + 1
    groups[at:at] = additions
    cfg['proxy-groups'] = groups
    if activate:
        found = 0
        for i, rule in enumerate(cfg['rules']):
            parts = rule.split(',')
            target = -2 if parts[-1].strip() == 'no-resolve' else -1
            if parts[target].strip() in ('ИИ', SELECTOR):
                parts[target] = SELECTOR
                cfg['rules'][i] = ','.join(parts)
                found += 1
        assert found, 'No AI rules to retarget'
    return cfg


def api(path, body=None, method=None, timeout=120):
    token = pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
    req = urllib.request.Request('http://127.0.0.1:63503' + path, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                                 data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        return json.loads(b) if b else {'status': r.status}


def config():
    return json.loads(subprocess.run(['/opt/sbin/yq', '-o=json', str(CONFIG)], capture_output=True, text=True, check=True).stdout)


def select(group, name):
    api('/api/mihomo/proxies/' + urllib.parse.quote(group, safe=''), {'name': name}, method='PUT')


def apply(activate):
    os.umask(0o077)
    BASE.mkdir(mode=0o700, exist_ok=True)
    cfg = config()
    backup = BASE / ('before-activate.yaml' if activate else 'before-prepare.yaml')
    if not backup.exists():
        backup.write_bytes(CONFIG.read_bytes())
    client = json.loads(CLIENT.read_text())
    candidate = transform(cfg, client, activate)
    assert transform(candidate, client, activate) == candidate
    assert {k: v for k, v in cfg.items() if k not in ('proxies', 'proxy-groups', 'rules')} == {k: v for k, v in candidate.items() if k not in ('proxies', 'proxy-groups', 'rules')}
    old_groups = {g['name']: g for g in cfg['proxy-groups'] if g['name'] not in NAMES}
    assert old_groups == {g['name']: g for g in candidate['proxy-groups'] if g['name'] not in NAMES}
    patch = {k: candidate[k] for k in ('proxies', 'proxy-groups', 'rules')}
    meta = api('/api/core/config')
    check = api('/api/core/config/check', {'sha': meta['sha'], 'set': patch})
    (BASE / 'check.json').write_text(json.dumps(check, ensure_ascii=False))
    assert check.get('ok') and check.get('valid'), 'HomeNet validation failed; see private check.json'
    if activate:
        assert not (BASE / 'watchdog.pid').exists(), 'An activation already started; inspect its result'
        with open(BASE / 'watchdog.log', 'ab', buffering=0) as log:
            p = subprocess.Popen(['/opt/bin/python3', str(BASE / 'route.py'), 'watch'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        (BASE / 'watchdog.pid').write_text(str(p.pid))
    result = api('/api/core/config/apply', {'sha': meta['sha'], 'set': patch})
    assert result.get('ok') and result.get('applied'), 'HomeNet apply failed'
    (BASE / ('activate.json' if activate else 'prepare.json')).write_text(json.dumps(result, ensure_ascii=False))
    select(ENTRANCE, 'Обходы')
    select(SELECTOR, SERVER_GROUP)
    print(json.dumps({'applied': True, 'ai_rules_active': activate, 'backup': result.get('backup'), 'sha': result.get('sha')}, ensure_ascii=False), flush=True)


def rollback():
    cfg = config()
    rules = []
    for rule in cfg['rules']:
        parts = rule.split(',')
        target = -2 if parts[-1].strip() == 'no-resolve' else -1
        if parts[target].strip() == SELECTOR:
            parts[target] = 'ИИ'
        rules.append(','.join(parts))
    meta = api('/api/core/config')
    result = api('/api/core/config/apply', {'sha': meta['sha'], 'set': {'rules': rules}})
    (BASE / 'rollback.json').write_text(json.dumps(result, ensure_ascii=False))
    print(json.dumps({'rolled_back': result.get('ok') and result.get('applied')}), flush=True)


def watch():
    for _ in range(210):
        if (BASE / 'confirmed').exists():
            return
        time.sleep(2)
    if not (BASE / 'confirmed').exists():
        rollback()


if __name__ == '__main__':
    phase = sys.argv[1]
    if phase == 'prepare':
        apply(False)
    elif phase == 'activate':
        apply(True)
    elif phase == 'watch':
        watch()
    elif phase == 'rollback':
        rollback()
    elif phase == 'confirm':
        assert (BASE / 'activate.json').exists()
        (BASE / 'confirmed').touch(mode=0o600)
        print('AI route confirmed')
