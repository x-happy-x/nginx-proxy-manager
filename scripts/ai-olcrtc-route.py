#!/usr/bin/env python3
"""Build a HomeNet config section patch from private Mihomo JSON on stdin."""
import argparse
import copy
import json
import re
import sys

SELECTOR = 'ИИ · сервер'
SERVER_GROUP = 'ИИ · OLC 88.214.53.84'
SERVER_NAME = 'AI-88.214.53.84'


def transform(original):
    cfg = copy.deepcopy(original)
    groups = cfg['proxy-groups']
    by_name = {g['name']: g for g in groups}
    if 'olcrtc' not in cfg.get('proxy-providers', {}):
        raise ValueError('HomeNet olcrtc provider is required')
    if 'ИИ' not in by_name:
        raise ValueError('Existing ИИ group is required')
    # Only this VPS's variants may be selected automatically. HomeNet prefixes
    # node names with a country flag; its server name survives variant repicks.
    server = {
        'name': SERVER_GROUP, 'type': 'fallback', 'use': ['olcrtc'],
        'filter': r'OLC ' + re.escape(SERVER_NAME) + r' ',
        'empty-fallback': 'REJECT',
        'url': 'https://www.gstatic.com/generate_204',
        'interval': 120, 'timeout': 15000, 'lazy': False,
    }
    # The first choice is the new VPS. Other servers/groups are explicit manual
    # choices; the selector never falls back to them when the VPS is down.
    options = [SERVER_GROUP] + [name for name in ('ИИ', 'ИИ прямые', 'ИИ обходы', 'OLCRTC') if name in by_name] + ['REJECT']
    sources = list(dict.fromkeys(['olcrtc'] + by_name['ИИ'].get('use', [])))
    selector = {'name': SELECTOR, 'type': 'select', 'proxies': options, 'use': sources}
    groups[:] = [g for g in groups if g.get('name') not in (SERVER_GROUP, SELECTOR)]
    at = next(i for i, g in enumerate(groups) if g['name'] == 'ИИ') + 1
    groups[at:at] = [server, selector]
    found = False
    for i, rule in enumerate(cfg['rules']):
        parts = rule.split(',')
        target = -2 if parts[-1].strip() == 'no-resolve' else -1
        if parts[target].strip() in ('ИИ', SELECTOR):
            parts[target] = SELECTOR
            cfg['rules'][i] = ','.join(parts)
            found = True
    if not found:
        raise ValueError('No existing AI rules were found')
    return cfg


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--patch', action='store_true')
    args = parser.parse_args()
    result = transform(json.load(sys.stdin))
    if args.patch:
        result = {key: result[key] for key in ('proxy-groups', 'rules')}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
