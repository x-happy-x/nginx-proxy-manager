#!/usr/bin/env python3
"""NPM-121: collapse AI routing to one selector; run on router."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = pathlib.Path('/opt/etc/mihomo/recovery-NPM-121')
CONFIG = pathlib.Path('/opt/etc/mihomo/config.yaml')
SETTINGS = pathlib.Path('/opt/etc/homenet/mihomo/routing.json')
NODE = 'Казахстан · VLESS'
OLD = {'ИИ прямые', 'ИИ обходы', 'ИИ · сервер', 'ИИ · KZ 38.180.37.198', 'ИИ · вход каскада'}
OLD_NODES = {'VLESS KZ · каскад', 'VLESS KZ · напрямую'}


def transform(original):
    cfg = copy.deepcopy(original)
    node = next(p for p in cfg['proxies'] if p['name'] in (NODE, 'VLESS KZ · каскад'))
    assert node['server'] == '38.180.37.198' and node['type'] == 'vless'
    node.update({'name': NODE, 'dialer-proxy': 'Обходы'})
    cfg['proxies'] = [p for p in cfg['proxies'] if p['name'] not in OLD_NODES | {NODE}] + [node]
    ai = next(g for g in cfg['proxy-groups'] if g['name'] == 'ИИ')
    ai.update({'type': 'select', 'proxies': [NODE], 'use': [n for n in ai.get('use', []) if n != 'olcrtc']})
    # Remove automatic country/ping constraints from this explicitly manual selector.
    ai = {k: ai[k] for k in ('name', 'type', 'proxies', 'use')}
    groups = []
    for g in cfg['proxy-groups']:
        if g['name'] in OLD:
            continue
        if g['name'] == 'ИИ':
            groups.append(ai)
            continue
        if 'proxies' in g:
            g['proxies'] = list(dict.fromkeys('ИИ' if n in OLD else NODE if n in OLD_NODES else n for n in g['proxies']))
        groups.append(g)
    cfg['proxy-groups'] = groups
    for i, rule in enumerate(cfg['rules']):
        parts = rule.split(',')
        target = -2 if parts[-1].strip() == 'no-resolve' else -1
        if parts[target].strip() in OLD:
            parts[target] = 'ИИ'
            cfg['rules'][i] = ','.join(parts)
    assert sum(g['name'].startswith('ИИ') for g in groups) == 1
    return cfg


def api(path, body=None, method=None):
    token = pathlib.Path('/opt/etc/homenet/core/credentials/vpn.token').read_text().strip()
    r = urllib.request.Request('http://127.0.0.1:63503' + path, data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), method=method,
                               headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=120) as reply:
        b = reply.read()
        return json.loads(b) if b else {}


def read_config():
    return json.loads(subprocess.run(['/opt/sbin/yq', '-o=json', str(CONFIG)], capture_output=True, text=True, check=True).stdout)


def save_settings(settings):
    temp = SETTINGS.with_suffix('.NPM121.tmp')
    temp.write_text(json.dumps(settings, ensure_ascii=False, indent=2))
    temp.chmod(0o600)
    temp.replace(SETTINGS)


def apply():
    os.umask(0o077)
    BASE.mkdir(mode=0o700, exist_ok=True)
    assert not (BASE / 'applied.json').exists(), 'Already applied; inspect checkpoint'
    before = read_config()
    (BASE / 'config-before.yaml').write_bytes(CONFIG.read_bytes())
    (BASE / 'routing-before.json').write_bytes(SETTINGS.read_bytes())
    candidate = transform(before)
    assert transform(candidate) == candidate
    patch = {k: candidate[k] for k in ('proxies', 'proxy-groups', 'rules')}
    meta = api('/api/core/config')
    check = api('/api/core/config/check', {'sha': meta['sha'], 'set': patch})
    assert check.get('valid'), check.get('detail')
    with open(BASE / 'watch.log', 'ab', buffering=0) as log:
        p = subprocess.Popen(['/opt/bin/python3', str(BASE / 'apply.py'), 'watch'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    (BASE / 'watch.pid').write_text(str(p.pid))
    result = api('/api/core/config/apply', {'sha': meta['sha'], 'set': patch})
    assert result.get('ok') and result.get('applied')
    (BASE / 'applied.json').write_text(json.dumps(result, ensure_ascii=False))
    settings = json.loads(SETTINGS.read_text())
    settings['single_ai_group'] = True
    save_settings(settings)
    api('/api/mihomo/proxies/' + urllib.parse.quote('ИИ', safe=''), {'name': NODE}, 'PUT')
    print(json.dumps({'applied': True, 'backup': result.get('backup'), 'group': 'ИИ', 'node': NODE}, ensure_ascii=False), flush=True)


def rollback():
    before = json.loads(subprocess.run(['/opt/sbin/yq', '-o=json', str(BASE / 'config-before.yaml')], capture_output=True, text=True, check=True).stdout)
    meta = api('/api/core/config')
    r = api('/api/core/config/apply', {'sha': meta['sha'], 'set': {k: before[k] for k in ('proxies', 'proxy-groups', 'rules')}})
    assert r.get('ok')
    current = json.loads(SETTINGS.read_text())
    previous = json.loads((BASE / 'routing-before.json').read_text())
    if 'single_ai_group' in previous:
        current['single_ai_group'] = previous['single_ai_group']
    else:
        current.pop('single_ai_group', None)
    save_settings(current)
    (BASE / 'rollback.json').write_text(json.dumps(r))


if __name__ == '__main__':
    phase = sys.argv[1]
    if phase == 'apply':
        apply()
    elif phase == 'rollback':
        rollback()
    elif phase == 'confirm':
        assert (BASE / 'applied.json').exists()
        (BASE / 'confirmed').touch(mode=0o600)
    elif phase == 'watch':
        for _ in range(210):
            if (BASE / 'confirmed').exists():
                sys.exit(0)
            time.sleep(2)
        rollback()
