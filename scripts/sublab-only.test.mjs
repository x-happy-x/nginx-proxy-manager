import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sublabOnly } from './sublab-only.mjs';

function fixture() {
  return [{
    secret: 'test-secret', dns: { enable: true }, rules: ['MATCH,AUTO'],
    proxies: [{ name: 'TS', type: 'tailscale' }],
    'proxy-providers': {
      ROUTER: { type: 'http' }, CHAIN: { type: 'file' },
      'SL-a': { type: 'file', path: '/a', 'health-check': { interval: 60 } },
      olcrtc: { type: 'file', path: '/olcrtc' },
    },
    'proxy-groups': [
      { name: 'AUTO', type: 'fallback', use: ['ROUTER', 'SL-a'], proxies: ['Каскад', 'OLCRTC'] },
      { name: 'Каскад', type: 'fallback', use: ['CHAIN'] },
      { name: 'OLCRTC', type: 'select', use: ['olcrtc'] },
      { name: 'Tailscale', type: 'select', proxies: ['TS'] },
    ],
  }, { base: 'ROUTER', cascade: true, access: [{ name: 'work' }] }, {
    managed: [{ provider: 'SL-a', path: '/a', title: 'Source', nodes: 2 }],
    groups: ['AUTO', 'Каскад'], applied_groups: ['AUTO', 'Каскад'],
  }];
}

test('removes legacy sources and cascade, preserving rules, DNS and special transports', () => {
  const inputs = fixture(), before = structuredClone(inputs);
  const result = sublabOnly(...inputs);
  assert.deepEqual(inputs, before);
  assert.deepEqual(Object.keys(result.config['proxy-providers']), ['SL-a', 'olcrtc']);
  assert.deepEqual(result.config['proxy-groups'][0].use, ['SL-a']);
  assert.deepEqual(result.config['proxy-groups'][0].proxies, ['OLCRTC']);
  for (const key of ['rules', 'dns', 'proxies', 'secret']) assert.deepEqual(result.config[key], inputs[0][key]);
  assert.equal(result.config['proxy-providers']['SL-a']['health-check'].interval, 60);
  assert.equal(result.routing.base, 'SL-a');
  assert.equal(result.routing.cascade, false);
  assert.deepEqual(result.sublab.groups, ['AUTO']);
  assert.deepEqual(sublabOnly(result.config, result.routing, result.sublab).config, result.config);
});

test('rejects missing sources, stale ownership and hidden cascade dependencies', () => {
  let inputs = fixture(); inputs[2].managed = [];
  assert.throws(() => sublabOnly(...inputs), /No active/);
  inputs = fixture(); inputs[2].managed[0].path = '/stale';
  assert.throws(() => sublabOnly(...inputs), /does not match/);
  inputs = fixture(); inputs[0].rules = ['MATCH,Каскад'];
  assert.throws(() => sublabOnly(...inputs), /cascade reference/);
  inputs = fixture(); inputs[0]['proxy-providers'].OTHER = { type: 'http' };
  assert.throws(() => sublabOnly(...inputs), /Unexpected provider/);
});
