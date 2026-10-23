import test from 'node:test';
import assert from 'node:assert/strict';
import { machineFromHardware,hardwareForMachine } from '../../frontend/src/features/machines/hardware-model.js';

test('Windows disk associations, virtual hardware and DIMM channels stay distinct',()=>{
 const m=machineFromHardware('pc',{os:'windows',cpu:{model:'AMD test',cores:16,threads:32},memory:{installed:96*1024**3,total:93*1024**3,slots:4,modules:[{slot:'DIMM 1',bank:'CHANNEL A',size_bytes:48*1024**3},{slot:'DIMM 1',bank:'CHANNEL B',size_bytes:48*1024**3}]},gpus:[{name:'GPU'},{name:'Virtual display',virtual:true}],disks:[{id:'disk:2',model:'SSD',kind:'nvme',size:2e12,volumes:['C:','D:']},{id:'disk:7',model:'VHD',kind:'virtual',virtual:true,size:1e12,volumes:['P:']}],devices:[{id:'usb:x',bus:'usb',address:'x',status:'unrecognized',problem_code:43,future:true}],nics:[{iface:'wifi',hardware:true,device_id:'same',kind:'wifi',state:'Up',speed_bps:866e6},{iface:'wifi old',hardware:true,device_id:'same',kind:'wifi',state:'Not Present'},{iface:'vEthernet',hardware:false}],reliability:[{id:'disk:2',status:'unavailable',reason:'denied'}]});
 assert.equal(m.memory,'96 ГБ');assert.equal(m.ram.length,4);assert.equal(m.ram.filter(v=>v===null).length,2);assert.equal(m.gpuNames.length,1);assert.equal(m.nics.length,1);assert.equal(m.disks.length,1);assert.equal(m.moreDisks,1);assert.equal(m.hidePeripheralUnknown,true);
 assert.match(m.parts.find(p=>p.id==='disk:disk:2').facts.find(f=>f[0]==='Тома')[1],/C:, D:/);
 assert.equal(m.parts.find(p=>p.id==='unknown').problemCode,43);assert.match(m.parts.find(p=>p.id==='unknown').raw,/"future": true/);
 assert.equal(m.parts.filter(p=>p.id.startsWith('dimm:')).length,2);assert.match(m.missing,/недоступны текущему пользователю/);
});

test('firmware slot order retains the exact occupied and empty locators',()=>{
 const m=machineFromHardware('s3',{hardware:{cpu:{model:'Ryzen'},memory:{slots:4,modules:[{slot:'DIMMA2',size_bytes:8*1024**3}],slot_records:[{slot:'DIMMA1',state:'empty'},{slot:'DIMMA2',state:'populated'},{slot:'DIMMB1',state:'empty'},{slot:'DIMMB2',state:'empty'}]},devices:[]},disks:[{dev:'sda',size:480e9,kind:'ssd'}]});
 assert.equal(m.ram.length,4);assert.deepEqual(m.slotRecords.map(s=>[s.label,s.state]),[['DIMMA1','empty'],['DIMMA2','populated'],['DIMMB1','empty'],['DIMMB2','empty']]);
 assert.match(m.ramCaption,/1 из 4 занято · 3 свободно/);assert.equal(m.parts.find(p=>p.id==='slot:DIMMA2').facts.find(r=>r[0]==='Device Locator')[1],'DIMMA2');
});

test('missing provider data never falls back to a demo model or zero sensor',()=>{
 const m=machineFromHardware('s2',null,'offline');assert.equal(m.temp,null);assert.equal(m.parts.length,1);assert.equal(m.parts[0].status,'Нет данных');assert.match(m.description,/offline/);
 const partial=machineFromHardware('pc',{os:'windows',sources:{system:{status:'unavailable',reason:'timeout'}}});assert.equal(partial.temp,null);assert.equal(partial.ram,null);assert.equal(partial.gpu,null);assert.match(partial.missing,/timeout/);
});

test('component identities survive reordered disks and PnP records',()=>{
 const data={cpu:{model:'CPU'},memory:{slots:1,modules:[{slot:'A2',size:'8 GB'}]},disks:[{id:'disk:9',model:'A',kind:'ssd',size:1e9},{id:'disk:3',model:'B',kind:'hdd',size:1e9}],devices:[{id:'pci:01',bus:'pci',status:'unrecognized'},{id:'usb:02',bus:'usb',status:'identified'}]};
 const first=machineFromHardware('pc',data),second=machineFromHardware('pc',{...data,disks:[...data.disks].reverse(),devices:[...data.devices].reverse()});
 assert.equal(first.parts.find(p=>p.name==='A').id,second.parts.find(p=>p.name==='A').id);
 assert.equal(first.parts.find(p=>p.rawId==='pci:01').id,second.parts.find(p=>p.rawId==='pci:01').id);
 assert.equal(first.memory,'8 ГБ');
});

test('legacy PC disks remain logical volumes and cores remain logical threads',()=>{
 const view=hardwareForMachine({key:'pc:legacy',name:'old PC',kind:'pc',online:false,pc:{current:{agent:'1.1.0',os:'windows',ts:123,cpu:{model:'AMD generic',cores:32},memory:{total:96*1024**3},network:[],disks:[{path:'C:',total:1e9,used:5e8}]}}});
 assert.equal(view.disks.length,0);assert.equal(view.volumes.length,1);assert.equal(view.offline,true);assert.equal(view.timestamp,123);
 assert.equal(view.parts.find(p=>p.id==='cpu').facts[0][1],'Не передано / 32');assert.match(view.missing,/1.2.0/);
});
test('legacy PVE DIMM capacities are parsed without guessing empty-slot labels',()=>{
 const view=hardwareForMachine({key:'node:old',name:'old',kind:'server',online:true,pve:{id:'old',hardware:{cpu:{model:'CPU',cores:4,threads:4},memory:{total:7.1*1024**3,slots:4,modules:[{slot:'DIMMA2',size:'8 GB'}]}},current:{ts:123,disks:[{dev:'sda',kind:'ssd',size:1e9}],temps:[],fans:[]}}});
 assert.equal(view.memory,'8 ГБ');assert.equal(view.slotRecords.length,4);assert.equal(view.slotRecords[0].slot,'DIMMA2');assert.ok(view.slotRecords.slice(1).every(s=>s.countOnly&&!s.slot));
});
