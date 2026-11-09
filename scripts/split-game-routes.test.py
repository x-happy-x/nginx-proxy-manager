import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('split_games', Path(__file__).with_name('split-game-routes.py'))
games = importlib.util.module_from_spec(spec)
spec.loader.exec_module(games)


class SplitGamesTest(unittest.TestCase):
    def setUp(self):
        self.config = {
            'secret': 'preserved', 'dns': {'enable': True},
            'proxy-providers': {'sub': {'health-check': {'adaptive': {'enable': True}}}},
            'proxy-groups': [
                {'name': 'Игры', 'type': 'fallback', 'proxies': ['DIRECT', 'Обходы', 'AUTO'], 'use': ['sub']},
                {'name': 'Keycloak', 'type': 'fallback', 'proxies': ['DIRECT']},
            ],
            'rule-providers': {'games_custom': {'type': 'inline', 'behavior': 'classical', 'payload': [
                'DOMAIN-SUFFIX,dnull.xyz', 'DOMAIN-SUFFIX,roblox.com',
                'IP-CIDR,155.212.214.234/32,no-resolve', 'DOMAIN-SUFFIX,ordinary.example',
            ]}},
            'rules': ['GEOIP,private,DIRECT,no-resolve', 'AND,((DST-PORT,443),(NETWORK,UDP)),QUIC',
                      'RULE-SET,games_custom,Игры', 'GEOSITE,supercell,Заблокированные сервисы',
                      'GEOSITE,category-ru,РФ', 'GEOIP,RU,РФ', 'MATCH,Остальное'],
        }

    def test_split_preserves_other_routes_and_settings(self):
        source = copy.deepcopy(self.config)
        cfg = games.transform(source)
        self.assertEqual(source, self.config)
        for key in ('secret', 'dns', 'proxy-providers'):
            self.assertEqual(cfg[key], source[key])
        for old in source['proxy-groups']:
            self.assertIn(old, cfg['proxy-groups'])
        self.assertEqual(cfg['rule-providers']['games_custom']['payload'], ['DOMAIN-SUFFIX,ordinary.example'])
        foreign = cfg['rule-providers'][games.PROVIDER]['payload']
        self.assertIn('IP-CIDR,155.212.214.229/32,no-resolve', foreign)
        self.assertIn('IP-CIDR,155.212.214.234/32,no-resolve', foreign)
        self.assertIn('DOMAIN-SUFFIX,dnull.xyz', foreign)
        self.assertLess(cfg['rules'].index(games.FOREIGN_RULE), cfg['rules'].index(source['rules'][1]))
        self.assertLess(cfg['rules'].index(f'GEOSITE,supercell,{games.GROUP}'), cfg['rules'].index(games.ORDINARY_RULE))
        self.assertLess(cfg['rules'].index(games.ORDINARY_RULE), cfg['rules'].index('GEOIP,RU,РФ'))

    def test_foreign_group_has_no_direct_or_unchecked_country(self):
        cfg = games.transform(self.config)
        group = next(g for g in cfg['proxy-groups'] if g['name'] == games.GROUP)
        self.assertNotIn('proxies', group)
        self.assertEqual(group['use'], ['sub'])
        self.assertTrue(group['strict-exit-countries'])
        self.assertEqual(group['empty-fallback'], 'REJECT')
        self.assertNotIn('RU', group['exit-countries'])
        self.assertNotIn('', group['exit-countries'])

    def test_repeat_application_is_idempotent_and_handles_empty_old_rules(self):
        self.config['rule-providers']['games_custom']['payload'] = ['DOMAIN-SUFFIX,dnull.xyz']
        first = games.transform(self.config)
        self.assertNotIn('games_custom', first['rule-providers'])
        self.assertNotIn('RULE-SET,games_custom,Игры', first['rules'])
        self.assertEqual(first, games.transform(first))


if __name__ == '__main__':
    unittest.main()
