import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';
import { pveFixtureHosts } from '../fixtures/pve.mjs';

async function source(file) {
 const code=ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const {machineTree,flatten,machineContainers,machineRoute,stoppedWsl}=await source('../../frontend/src/features/machines/model.ts');
const {unifiedMachineRoute}=await source('../../frontend/src/platform/machine-routes.ts');
const {combinedEvents}=await source('../../frontend/src/features/machines/events.ts');

test('VM and agent share one identity by placement IP; WSL stays under its host',()=>{
 const hosts=pveFixtureHosts();
 const computers=[{id:'agent',name:'different-name',address:'203.0.113.42',online:false,current:{wsl:[],docker:[{context:'native',containers:[{id:'c'}]}]}},{id:'windows',name:'PC-X',address:'203.0.113.10',online:true,current:{wsl:[{name:'Ubuntu',state:'running'},{name:'Debian',state:'stopped'}],docker:[]}}];
 const roots=machineTree(hosts,computers,[{server:'s3',vmid:101,ips:['203.0.113.42']}]);
 assert.equal(roots.length,4);
 const vm=flatten(roots).find(m=>m.guest?.vmid===101);
 assert.equal(vm.pc.id,'agent');
 assert.equal(vm.parent.name,'s3');
 assert.equal(machineContainers(vm).length,1);
 assert.equal(machineRoute(vm),'pveguests/s3/qemu/101');
 assert.deepEqual(roots[3].children.map(w=>w.online),[true,false]);
 assert.equal(flatten(roots).filter(m=>m.pc?.id==='agent').length,1);
 assert.equal(flatten(roots).filter(m=>m.guest).length,6);
 assert.equal(machineTree(hosts,[]).length,3);
 assert.equal(machineTree([],computers).length,2);
});
test('names alone cannot merge an unrelated PC with a VM',()=>{
 const tree=machineTree(pveFixtureHosts(),[{id:'different',name:'family-apps',address:'203.0.113.99',online:true,current:null}]);
 assert.equal(tree.length,4);
 assert.equal(flatten(tree).filter(m=>m.name==='family-apps').length,2);
});
test('loss of the PC connection does not turn running WSL into stopped WSL',()=>{
 const [pc]=machineTree([],[{id:'pc',name:'PC',address:'203.0.113.1',online:false,current:{wsl:[{name:'Ubuntu',state:'running'},{name:'Debian',state:'stopped'}],docker:[]}}]);
 assert.deepEqual(pc.children.map(w=>w.online),[false,false]);
 assert.deepEqual(pc.children.filter(stoppedWsl).map(w=>w.name),['Debian']);
});
test('legacy links redirect only while PVE is enabled',()=>{
 assert.equal(unifiedMachineRoute('#/pcdocker',true),'pve/containers');
 assert.equal(unifiedMachineRoute('#/pcdocker?host=pc&context=wsl%3AUbuntu',true),'pve/containers?host=pc&context=wsl%3AUbuntu');
 assert.equal(unifiedMachineRoute('#/pc',true),'pveguests?filter=pc');
 assert.equal(unifiedMachineRoute('#/pcwsl',true),'pveguests?filter=wsl');
 assert.equal(unifiedMachineRoute('#/pc/host/family-apps',true),'pveguests/pc/family-apps');
 assert.equal(unifiedMachineRoute('#/pveguests/s3/qemu/101',true),null);
 for(const id of ['pc','pcdocker','pcwsl','pcsettings','pc/events']) assert.equal(unifiedMachineRoute(`#/${id}`,false),null);
});
test('combined inbox namespaces collisions and sends read receipt to the correct worker',async()=>{
 const calls=[];
 const host=source=>({api:async(path,init)=>{calls.push([source,path,init?.body&&JSON.parse(init.body)]);return Response.json({events:[{id:'same',host:'same',created_at:source==='pc'?'2026-10-23':'2026-10-22'}],unread:1});}});
 const api=combinedEvents(host('pve'),host('pc'),true);
 const inbox=await (await api.api('/api/pve/events')).json();
 assert.deepEqual(inbox.events.map(e=>e.id),['pc:same','pve:same']);
 assert.equal(inbox.unread,2);
 calls.length=0;
 await api.api('/api/pve/events/read',{method:'POST',body:JSON.stringify({ids:['pc:same']})});
 assert.deepEqual(calls.find(c=>c[0]==='pc'),['pc','/api/pc/events/read',{ids:['same']}]);
 assert.equal(calls.find(c=>c[0]==='pve')[1],'/api/pve/events');
});
test('partial inbox failure remains visible and a failed write never reports success',async()=>{
 const good={api:async()=>Response.json({events:[],unread:0})}, bad={api:async()=>{throw Error('PC unavailable');}};
 const api=combinedEvents(good,bad,true);
 assert.match((await(await api.api('/api/pve/events')).json()).source_error,/PC unavailable/);
 await assert.rejects(()=>api.api('/api/pve/events/read',{body:'{"all":true}'}),/PC unavailable/);
 const single=await(await combinedEvents(good,bad,false).api('/api/pve/events')).json();
 assert.equal(single.storage_error,'');
});
