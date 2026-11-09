"""Pure transformations for the offline router export; no device writes."""
import copy
import json
import posixpath
import re


def runtime_binary_name(name, actual):
    # iproute2 treats an executable called ip-FOO as the command `ip FOO`.
    # Entware's ip-full therefore needs the basename `ip` under our loader.
    return 'ip' if name == 'ip' else posixpath.basename(actual)


def transfer_integrations(registry):
    selected = []
    for name in ('vpn', 'network'):
        item = next((i for i in registry['items'] if i['manifest']['id'] == name and i.get('enabled')), None)
        if item is None:
            raise RuntimeError('Required source integration is not enabled: ' + name)
        selected.append(copy.deepcopy(item))
    return {'schema': 1, 'items': selected}


def without_tail_state(value, names):
    """Drop access/routing entries naming a removed node, retaining OLCRTC data."""
    if isinstance(value, str):
        return None if value in names or 'tailscale://' in value.lower() else value
    if isinstance(value, list):
        return [v for x in value if (v := without_tail_state(x, names)) is not None]
    if isinstance(value, dict):
        return {k: v for k, x in value.items() if k not in names and (v := without_tail_state(x, names)) is not None}
    return value


def without_tail(config):
    c = copy.deepcopy(config)
    removed = {p['name'] for p in c.get('proxies', []) if p.get('type', '').lower() == 'tailscale'}
    c['proxies'] = [p for p in c.get('proxies', []) if p.get('name') not in removed]
    for p in c['proxies'] + list(c.get('proxy-providers', {}).values()):
        if p.get('dialer-proxy') in removed:
            p.pop('dialer-proxy')
    groups = c.get('proxy-groups', [])
    while True:
        added = set()
        for g in groups:
            if g.get('name') in removed:
                continue
            if 'proxies' in g:
                g['proxies'] = [p for p in g['proxies'] if p not in removed]
                if not g['proxies'] and not g.get('use'):
                    added.add(g['name'])
        if not added:
            break
        removed.update(added)
    c['proxy-groups'] = [g for g in groups if g.get('name') not in removed]
    for g in c['proxy-groups']:
        for k in ('mode-priority',):
            for mode, nodes in (g.get(k) or {}).items():
                g[k][mode] = [p for p in nodes if p not in removed]
    for key in ('rules',):
        c[key] = [r for r in c.get(key, []) if not any(p.strip() in removed for p in r.split(','))]
    for key, rules in list((c.get('sub-rules') or {}).items()):
        c['sub-rules'][key] = [r for r in rules if not any(p.strip() in removed for p in r.split(','))]

    def clean_dns(value):
        if isinstance(value, str):
            return None if value.lower().startswith('tailscale://') else value
        if isinstance(value, list):
            return [v for x in value if (v := clean_dns(x)) is not None]
        if isinstance(value, dict):
            return {k: v for k, x in value.items() if (v := clean_dns(x)) is not None and v != []}
        return value
    c['dns'] = clean_dns(c.get('dns', {}))
    for key in ('external-ui', 'external-ui-url', 'external-ui-name', 'external-controller-tls',
                'external-controller-unix', 'external-controller-pipe', 'hosts', 'tun', 'iptables', 'authentication'):
        c.pop(key, None)
    c['external-controller'] = '127.0.0.1:9090'
    c['allow-lan'] = True
    c['profile'] = {'store-selected': True, 'store-fake-ip': True}
    c['listeners'] = [v for v in c.get('listeners', []) if v.get('proxy') not in removed]
    return c, sorted(removed)


def provider_path(path):
    p = posixpath.normpath(posixpath.join('/opt/etc/mihomo', path))
    if not p.startswith('/opt/etc/mihomo/'):
        raise ValueError('Provider is outside /opt/etc/mihomo')
    return p


def portable_runtime_env():
    return '\n'.join([
        'ROUTES_PATH=/opt/etc/homenet/nginx/routes.yml',
        'MIHOMO_CONFIG=/opt/etc/mihomo/config.yaml',
        'MIHOMO_BINARY=/opt/sbin/mihomo',
        'MIHOMO_HOME=/opt/etc/mihomo',
        'MIHOMO_STATE_DIR=/opt/etc/homenet/mihomo',
        'MIHOMO_CONTROLLER=http://127.0.0.1:9090',
        'MIHOMO_SOCKS=127.0.0.1:7891',
        'MIHOMO_DNS_MODE=system-hosts',
        'MIHOMO_HOSTS_PATH=/etc/hosts',
        'NDMC_BIN=ndmc',
        'HOMENET_ACCESS_ENABLED=1',
    ]) + '\n'


def runtime_script(data):
    text = data.decode('utf-8')
    prefix = 'HOMENET_RUNTIME=/opt/share/homenet/offline-runtime\nexport HOMENET_RUNTIME\nPATH="$HOMENET_RUNTIME/bin:/opt/bin:/opt/sbin:/sbin:/bin:/usr/sbin:/usr/bin"\nexport PATH\n'
    lines = text.splitlines(keepends=True)
    if lines and lines[0].startswith('#!') and not (len(lines)>1 and lines[1].startswith('HOMENET_RUNTIME=')):
        lines.insert(1, prefix)
    elif not lines or not lines[0].startswith('#!'):
        lines.insert(0, prefix)
    # XKeen's service explicitly resets PATH; retain its private offline tools.
    text = ''.join(lines)
    # XKeen emits fresh NDM hooks from quoted shell heredocs at each start.
    # Give those generated scripts the same private utilities as the parent.
    text = re.sub(r'(?m)^(#!/bin/sh\n)(?!HOMENET_RUNTIME=)',lambda m:m[1]+prefix,text)
    text = re.sub(r'^PATH="/opt/bin:', 'PATH="$HOMENET_RUNTIME/bin:/opt/bin:', text, flags=re.M)
    return text.encode()
