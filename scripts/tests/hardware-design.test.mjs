import test from 'node:test';
import assert from 'node:assert/strict';
import { machineFromHardware } from '../../docs/machines-hardware-data.js';

test('Windows disk associations, virtual hardware and DIMM channels stay distinct',()=>{
 const m=machineFromHardware('pc',{os:'windows',cpu:{model:'AMD test',cores:16,threads:32},memory:{installed:96*1024**3,total:93*1024**3,slots:4,modules:[{slot:'DIMM 1',bank:'CHANNEL A',size_bytes:48*1024**3},{slot:'DIMM 1',bank:'CHANNEL B',size_bytes:48*1024**3}]},gpus:[{name:'GPU'},{name:'Virtual display',virtual:true}],disks:[{id:'disk:2',model:'SSD',kind:'nvme',size:2e12,volumes:['C:','D:']},{id:'disk:7',model:'VHD',kind:'virtual',virtual:true,size:1e12,volumes:['P:']}],devices:[{id:'usb:x',bus:'usb',address:'x',status:'unrecognized',problem_code:43,future:true}],nics:[{iface:'wifi',hardware:true,device_id:'same',kind:'wifi',state:'Up',speed_bps:866e6},{iface:'wifi old',hardware:true,device_id:'same',kind:'wifi',state:'Not Present'},{iface:'vEthernet',hardware:false}],reliability:[{id:'disk:2',status:'unavailable',reason:'denied'}]});
 assert.equal(m.memory,'96 ГБ');assert.equal(m.ram.length,4);assert.equal(m.ram.filter(v=>v===null).length,2);assert.equal(m.gpuNames.length,1);assert.equal(m.nics.length,1);assert.equal(m.disks.length,1);assert.equal(m.moreDisks,1);assert.equal(m.hidePeripheralUnknown,true);
 assert.match(m.parts.find(p=>p.id==='disk:0').facts.find(f=>f[0]==='Тома')[1],/C:, D:/);
 assert.equal(m.parts.find(p=>p.id==='unknown').problemCode,43);assert.match(m.parts.find(p=>p.id==='unknown').raw,/"future": true/);
 assert.equal(m.parts.filter(p=>p.id.startsWith('dimm:')).length,2);assert.match(m.missing,/недоступны текущему пользователю/);
});

test('firmware slot order retains the exact occupied and empty locators',()=>{
 const m=machineFromHardware('s3',{hardware:{cpu:{model:'Ryzen'},memory:{slots:4,modules:[{slot:'DIMMA2',size_bytes:8*1024**3}],slot_records:[{slot:'DIMMA1',state:'empty'},{slot:'DIMMA2',state:'populated'},{slot:'DIMMB1',state:'empty'},{slot:'DIMMB2',state:'empty'}]},devices:[]},disks:[{dev:'sda',size:480e9,kind:'ssd'}]});
 assert.equal(m.ram.length,4);assert.deepEqual(m.slotRecords.map(s=>[s.label,s.state]),[['DIMMA1','empty'],['DIMMA2','populated'],['DIMMB1','empty'],['DIMMB2','empty']]);
 assert.match(m.ramCaption,/1 из 4 занято · 3 свободно/);assert.equal(m.parts.find(p=>p.id==='slot:1').facts.find(r=>r[0]==='Device Locator')[1],'DIMMA2');
});

test('missing provider data never falls back to a demo model or zero sensor',()=>{
 const m=machineFromHardware('s2',null,'offline');assert.equal(m.temp,null);assert.equal(m.parts.length,1);assert.equal(m.parts[0].status,'Нет данных');assert.match(m.description,/offline/);
 const partial=machineFromHardware('pc',{os:'windows',sources:{system:{status:'unavailable',reason:'timeout'}}});assert.equal(partial.temp,null);assert.equal(partial.ram,null);assert.equal(partial.gpu,null);assert.match(partial.missing,/timeout/);
});
