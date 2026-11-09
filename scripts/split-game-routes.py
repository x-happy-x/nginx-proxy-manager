#!/usr/bin/env python3
"""Split a JSON representation of Mihomo YAML without replacing other settings."""
import copy
import json
import sys

GROUP = 'Игры вне РФ'
PROVIDER = 'games_blocked_ru'
FOREIGN_RULE = f'RULE-SET,{PROVIDER},{GROUP}'
ORDINARY_RULE = 'GEOSITE,category-games,Игры'
# ISO alpha-2 exits; RU and an unknown country can never satisfy this policy.
COUNTRIES = '''AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI
BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV
CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE
GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO
IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT
LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA
NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA
RE RO RS RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD
TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU
WF WS YE YT ZA ZM ZW'''.split()


def blocked(rule):
    value = rule.lower()
    if any(word in value for word in ('nulls', 'nullbrawl', 'dnull.', 'brawl',
                                      'supercell', 'roblox', 'rbxcdn', 'rbxinfra')):
        return True
    if any(ip in value for ip in ('135.125.37.166/', '155.212.214.229/', '155.212.214.234/')):
        return True
    return (('ip-asn,22697' in value and 'dst-port,49152-65535' in value)
            or (any(asn in value for asn in ('ip-asn,14618', 'ip-asn,16509'))
                and 'dst-port,9339' in value))


def transform(original):
    cfg = copy.deepcopy(original)
    groups = cfg['proxy-groups']
    games = next((g for g in groups if g.get('name') == 'Игры'), None)
    if games is None:
        raise ValueError('Existing Игры group is required')
    providers = cfg.get('proxy-providers', {})
    sources = [name for name in games.get('use', [])
               if providers.get(name, {}).get('health-check', {}).get('adaptive', {}).get('enable')]
    if not sources:
        raise ValueError('Game exits require providers with adaptive country checks')
    rulesets = cfg.setdefault('rule-providers', {})
    previous = rulesets.get('games_custom', {'type': 'inline', 'behavior': 'classical', 'payload': []})
    if previous.get('type') != 'inline' or previous.get('behavior') != 'classical':
        raise ValueError('games_custom must be an inline classical ruleset')
    old_blocked = rulesets.get(PROVIDER, {}).get('payload', [])
    foreign = list(dict.fromkeys(old_blocked + [r for r in previous.get('payload', []) if blocked(r)] + [
        'IP-CIDR,155.212.214.229/32,no-resolve',
        'IP-CIDR,155.212.214.234/32,no-resolve',
    ]))
    ordinary = [r for r in previous.get('payload', []) if not blocked(r)]
    if ordinary:
        rulesets['games_custom'] = dict(previous, payload=ordinary)
    else:
        rulesets.pop('games_custom', None)
    rulesets[PROVIDER] = {'type': 'inline', 'behavior': 'classical', 'payload': foreign}

    group = {
        'name': GROUP, 'type': 'fallback', 'use': sources,
        'exit-countries': COUNTRIES, 'strict-exit-countries': True,
        'empty-fallback': 'REJECT', 'exclude-type': 'HTTP|SSH',
        'url': 'https://www.gstatic.com/generate_204',
        'health-check-urls': ['https://cp.cloudflare.com/generate_204'],
        'interval': 600, 'timeout': 5000, 'max-failed-times': 2,
        'lazy': False, 'passive-check': True, 'sticky': True,
    }
    groups[:] = [g for g in groups if g.get('name') != GROUP]
    groups.insert(groups.index(games) + 1, group)

    rules = []
    for rule in cfg['rules']:
        if rule in (FOREIGN_RULE, ORDINARY_RULE):
            continue
        if rule.startswith('RULE-SET,games_custom,') and not ordinary:
            continue
        if rule.startswith('GEOSITE,supercell,'):
            rule = f'GEOSITE,supercell,{GROUP}'
        rules.append(rule)
    # Exact game IPs must precede both the blanket UDP/443 rejection and GEOIP.
    at = next((i for i, r in enumerate(rules)
               if r.endswith(',QUIC') or r.startswith(('GEOSITE,category-ru,',
                                                       'GEOIP,RU,', 'MATCH,'))), len(rules))
    rules.insert(at, FOREIGN_RULE)
    at = next((i for i, r in enumerate(rules)
               if r.startswith(('GEOSITE,category-ru,', 'GEOIP,RU,', 'MATCH,'))), len(rules))
    rules.insert(at, ORDINARY_RULE)
    cfg['rules'] = rules
    return cfg


if __name__ == '__main__':
    result = transform(json.load(sys.stdin))
    if '--patch' in sys.argv[1:]:
        result = {key: result[key] for key in ('proxy-groups', 'rule-providers', 'rules')}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
