import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';
const source = await readFile(new URL('../../frontend/src/features/servers/publication.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { publicDomainDraft, vpsHost, publicationChannels, setPublicationEnabled } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
const hosts = [
  { host: 'app.crubs.crazedns.ru', app_id: 'app', kind: 'public', access_app: 'account', endpoints: [{ name: 'ndns', listen: { protocol: 'http', port: 24100 }, behavior: { ndns_profile: 'ndns_proxy' } }] },
  { host: 'alias.crubs.crazedns.ru', app_id: 'app', kind: 'public', endpoints: [{ name: 'ndns', listen: { protocol: 'http', port: 24101 }, behavior: { ndns_profile: 'ndns_proxy' } }] },
  vpsHost(undefined, 'app.cdn6.ru', 'app', 'cdn6'),
  vpsHost(undefined, 'app.another.example', 'app', 'second-vps'),
];
const drafts = hosts.map(h => publicDomainDraft(h, 'crubs.crazedns.ru'));
assert.equal(drafts.length, 4);
assert.deepEqual(drafts.map(h => h.serverId), ['', '', 'cdn6', 'second-vps']);
assert.deepEqual(drafts.slice(0, 2).map(h => h.externalPort), ['24100', '24101']);
const migrated = vpsHost(hosts[0], 'app.cdn6.ru', 'app', 'cdn6');
assert.equal(migrated.access_app, 'account', 'VPS must preserve the HomeNet access policy');
assert.deepEqual(migrated.dns.publish, ['local'], 'LAN must resolve the public domain directly to the home proxy');
assert.equal(migrated.tls.cert_policy, 'public_vps');
assert.equal(migrated.endpoints.length, 2);
assert.equal(migrated.endpoints[0].name, 'web');
const assigned = { ...migrated, endpoints: [{ ...migrated.endpoints[1], listen: { protocol: 'http', port: 24555 } }] };
assert.equal(vpsHost(assigned, 'renamed.cdn6.ru', 'app', 'second-vps').endpoints.find(e=>e.name==='vps').listen.port, 24555);
const doc = { globals: {}, hosts };
assert.deepEqual(publicationChannels(doc, [{ id:'cdn6', name:'VPS cdn6' }]).map(c=>[c.id,c.domains]), [['vps:cdn6',1],['keendns:ndns_proxy',2],['vps:second-vps',1]]);
const disabled = setPublicationEnabled(setPublicationEnabled(doc,'vps:cdn6',false),'keendns:ndns_proxy',false);
assert.deepEqual(setPublicationEnabled(disabled,'vps:cdn6',true).globals.disabled_publications,['keendns:ndns_proxy']);
assert.equal(disabled.hosts,hosts,'switches must retain every domain and local listener');
assert.equal(hosts[0].endpoints[0].listen.port, 24100, 'editing one alias must not mutate another');
console.log('Public domains: simultaneous KeenDNS aliases, two VPS, stable ports and access rules passed');
