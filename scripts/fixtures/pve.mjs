// Synthetic, loopback-only acceptance data for the Proxmox redesign.
const GB = 1024 ** 3;
const events = [{ id: 'backup-error', host: 's1', kind: 'task_error', severity: 'error', title: 'Ошибка резервной копии', message: 'VM 1000: нет места в local.', created_at: new Date(Date.now()-86400000).toISOString() }];
const ro = { control: false, guest_actions: [], node_actions: [] };
const names = ['home-server', 'home-assistant', 'plane-vm', 'test-server', 'family-apps', 'forgejo-ci'];
const ids = [100,1000,1001,201,101,102];
const ips = ['192.168.99.13','192.168.99.12','','','192.168.99.33','192.168.99.34'];
function guest(i) { const running = ![2,3].includes(i); return { vmid:ids[i], name:names[i], type:process.env.PREVIEW_PVE_LXC && i===5 ? 'lxc' : 'qemu', status:running?'running':'stopped', template:false, lock:'', tags:i===1?'home;automation':'home', cpu:running?[24,3,0,0,5,12][i]:0, cpus:[3,4,4,2,2,2][i], mem:running?[2.1,5.3,0,0,1.7,2.4][i]*GB:0, maxmem:[4,6,4,4,4,3][i]*GB, disk:12*GB, maxdisk:64*GB, uptime:running?248400:0, ips:ips[i]?[ips[i]]:[], macs:['bc:24:11:20:6b:cb'], netin_rate:2000,netout_rate:800, diskread_rate:0,diskwrite_rate:97000,
  config:{ cpu:'host', memory:[4096,6144,4096,4096,4096,3072][i], agent:'1',balloon:0,disks:[{slot:'scsi0',volume:`local-lvm:vm-${ids[i]}-disk-0`,size:'64G'}],networks:[{slot:'net0',bridge:'vmbr0',mac:'bc:24:11:20:6b:cb'}] } }; }
export function pveFixtureHosts() { const now=Math.floor(Date.now()/1000); return [0,1,2].map(i=>{
  const id=`s${i+1}`, list=(i===0?[0,1,2]:i===1?[3]:[4,5]).map(guest), total=[15,8,7.1][i]*GB, used=[12.3,1.7,5.8][i]*GB;
  const h={ id,name:id,address:`192.168.99.${(i+1)*10}`,online:!(process.env.PREVIEW_PVE_OFFLINE&&i===2),error:process.env.PREVIEW_PVE_OFFLINE&&i===2?'Нет ответа по SSH':'',checked_at:new Date().toISOString(),last_ok:new Date().toISOString(),latency_ms:12,capabilities:ro,
    current:{host:i===2?'pve3':id,ts:now-2,interval:10,node:{cpu:[24,3,12][i],iowait:0,load:[.3,.2,.1],threads:4,freq_mhz:2400,uptime:388000,mem:{total,used,avail:total-used,cached:GB,ksm:0},swap:{total:0,used:0},cpu_temp:[48,35,30][i]},
    temps:[{chip:'coretemp',label:'Package id 0',c:[48,35,30][i],crit:100,max:90},...Array.from({length:4},(_,n)=>({chip:'coretemp',label:`Core ${n}`,c:45+i+n,crit:100}))],fans:[],net:[{iface:'eno1',rx:1800,tx:500,state:'up',speed:1000,bridge:false}],io:[{dev:'sda',r:0,w:97000,util:2}],guests:list,
    storage:[{name:'local',type:'dir',used:45*GB,total:94*GB,active:true,enabled:true,shared:false,content:'backup,iso'},{name:'local-lvm',type:'lvmthin',used:[300,27,140][i]*GB,total:[832,160,160][i]*GB,active:true,enabled:true,shared:false,content:'images,rootdir'}],
    zfs:i===1?[{name:'archive',size:200*GB,alloc:80*GB,free:120*GB,frag:0,cap:40,health:'ONLINE'}]:[],
    disks:[{dev:i===0?'nvme0n1':'sda',kind:i===0?'nvme':'ssd',model:['XG7000-1TB 2280','SATA SSD 240GB','Диск без SMART'][i],serial:'FIXTURE',size:256*GB,transport:'sata',firmware:'1.0',health:i===2?null:true,temp:i===2?null:39,wear:i===2?null:i===1?31:2,hours:null,cycles:null,written:null,media_errors:null,reallocated:null}],
    updates:i===0?12:0,failed_units:[],backups:i===1?[]:Array.from({length:14},(_,n)=>({id:`copy-${i}-${n}`,vmid:list[0].vmid,status:i===0&&n===4?'ERROR: нет места в local':'OK',start:now-n*86400-10800,end:now-n*86400-10400,size:6.2*GB,storage:'local',source:'task'})),versions:{pve:'8.4',kernel:'6.8.12-pve',agent:'1.4.0'},cluster:{name:'proxmox',quorate:true,nodes:[0,1,2].map(n=>({name:`s${n+1}`,ip:`192.168.99.${(n+1)*10}`,online:true,local:i===n}))}},
    hardware:{vendor:['Mini PC','Acer','HomeLab'][i],product:['N150','TravelMate','Mini PC'][i],board:'Board',bios:'1.0',cpu:{model:['Intel N150','Intel Core i5-6200U','Intel Core i3'][i],threads:4,cores:4,sockets:1,max_mhz:3200,virt:'VT-x',arch:'x86_64'},memory:{total,slots:2,modules:[]},nics:[],gpus:[],controllers:['SATA controller','NVMe controller']}};
  if(process.env.PREVIEW_PVE_LEGACY){h.current.versions.agent='1.3.0';h.current.guests.forEach(g=>delete g.config);h.current.backups.forEach(b=>{delete b.vmid;delete b.size;});}
  return h;
}); }
export const pvePortalFixture={apps:names.filter((_,i)=>ips[i]).map((name,i)=>({id:name,name,upstream:{address:['192.168.99.13','192.168.99.12','192.168.99.33','192.168.99.34'][i],port:8080,scheme:'http'}})),hosts:[]};
export function fakePve(req,res) {
  const u=new URL(req.url,'http://localhost'),hosts=pveFixtureHosts();
  const send=(d,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(d));};
  if(u.pathname==='/api/pve/overview'){send({configured:true,error:'',hosts});return true;}
  if(u.pathname==='/api/pve/history'){const h=hosts.find(h=>h.id===u.searchParams.get('host'));if(!h){send({error:'unknown host'},404);return true;}const now=Math.floor(Date.now()/1000),points=Array.from({length:1440},(_,i)=>({t:now-(1439-i)*60,cpu:20+Math.sin(i/12)*12,mem:h.current.node.mem.used,io:1,load:.8,temp:48+Math.sin(i/18)*12,rx:2000,tx:900,r:0,w:97000}));send({step:60,points,guests:Object.fromEntries(h.current.guests.filter(g=>g.status==='running').map(g=>[g.vmid,points.filter((_,i)=>i%5===0).map(p=>[p.t,Math.max(0,g.cpu+Math.sin(p.t)*3),g.mem])]))});return true;}
  if(u.pathname==='/api/pve/events'){send({events,unread:events.filter(e=>!e.read_at).length});return true;}
  if(u.pathname==='/api/pve/events/read'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{const d=JSON.parse(body);events.forEach(e=>{if(d.all||d.ids?.includes(e.id))e.read_at=new Date().toISOString();});send({events,unread:events.filter(e=>!e.read_at).length});}catch{send({error:'invalid JSON'},400);}});return true;}
  if(u.pathname==='/api/pve/placement'){send({nodes:hosts.map(h=>({server:h.id,server_name:h.name,ip:h.address,online:h.online})),machines:hosts.flatMap(h=>h.current.guests.map(g=>({...g,server:h.id,server_name:h.name})))});return true;}
  if(u.pathname==='/api/pve/tasks'){send({tasks:[]});return true;}
  if(u.pathname==='/api/pve/actions'){send({error:'Read-only preview; power is disabled'},403);return true;}
  if(u.pathname==='/api/pve/config'&&req.method==='GET'){send({hosts:hosts.map(h=>({id:h.id,name:h.name,address:h.address,port:22,user:'root',pinned:true})),public_key:'ssh-ed25519 AAAAPreview homenet-preview'});return true;}
  return false;
}
