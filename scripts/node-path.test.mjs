import test from 'node:test';
import assert from 'node:assert/strict';
import {pathOf} from '../frontend/src/features/mihomo/node-path.ts';
test('shows the physical entry before the final VLESS and preserves final-exit identity',()=>{
 const p={AI:{now:'KZ'},KZ:{'dialer-proxy':'entry'},entry:{now:'server'},server:{}};
 assert.deepEqual(pathOf('AI',p),['AI','entry','server','KZ']);
 assert.equal(pathOf('AI',p).at(-1),'KZ');
 assert.deepEqual(pathOf('KZ',p),['entry','server','KZ']);
});
test('plain selection, unknown peers and cyclic references stay bounded',()=>{
 assert.deepEqual(pathOf('AI',{AI:{now:'server'}}),['AI','server']);
 assert.deepEqual(pathOf('AI',{AI:{now:'KZ'},KZ:{'dialer-proxy':'entry'},entry:{now:'KZ'}}),['AI','entry','KZ']);
 assert.deepEqual(pathOf('missing',{}),['missing']);
});
