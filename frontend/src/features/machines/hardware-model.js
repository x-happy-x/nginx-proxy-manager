// Shared inventory adapter for React and the design preview. Unknown source fields stay intact.
const bytes=n=>n?`${Number((n/1024**3).toFixed(1)).toLocaleString('ru-RU')} ГБ`:'Не передано';
const diskSize=n=>!(Number.isFinite(Number(n))&&n>0)?'объём неизвестен':n>=1e12?`${Number((n/1e12).toFixed(1)).toLocaleString('ru-RU')} ТБ`:`${Math.round(n/1e9)} ГБ`;
const value=v=>v===null||v===undefined||v===''?'Не передано':String(v);
const short=(v,n=22)=>String(v||'').length>n?String(v).slice(0,n-1)+'…':String(v||'');
const plural=(n,words)=>words[n%100>=11&&n%100<=14?2:n%10===1?0:n%10>=2&&n%10<=4?1:2];
const row=(id,name,kind,facts,extra={})=>({id,name,kind,facts,status:'Определён',...extra});
const speed=n=>n>0?n>=1e9?`${Number((n/1e9).toFixed(1))} Гбит/с`:`${Math.round(n/1e6)} Мбит/с`:null;
const gpuName=s=>s.replace(/\s*\(rev [^)]+\)/g,'').replace(/^(?:NVIDIA Corporation |Intel Corporation )/,'').replace(/^.*\[([^\]]*(?:GeForce|Radeon|Graphics)[^\]]*)\].*$/,'$1');
export function machineFromHardware(id, document, error) {
  const name=id==='pc'?'PC-X':id;
  if(!document) return {name,sub:'Нет снимка',description:error||'Сбор не выполнен',board:name,cpuLines:['CPU','Нет данных',''],cpuSummary:'Нет данных',temp:null,memory:'—',ram:null,disks:[],nics:[],gpu:null,parts:[row('cpu','Инвентарь недоступен','Сбор данных',[['Причина',error||'Нет снимка']],{status:'Нет данных',source:'Сборщик'})],extras:[],sensors:[],missing:error||'Сбор не выполнен',collected:true};
  const raw=document.hardware||document, h={...raw, memory:{...(raw.memory||{})}}, windows=h.os==='windows', source=h.source||'pve-agent', cpu=h.cpu||{}, memory=h.memory;
  memory.modules=(Array.isArray(memory.modules)?memory.modules:[]).map(m=>({...m,size_bytes:m.size_bytes||legacyMemoryBytes(m.size)}));
  const modules=memory.modules||[], physical=(document.disks||h.disks||[]), devices=h.devices||[];
  const gpus=(h.gpus||[]).map(g=>typeof g==='string'?{name:gpuName(g),source:'lspci'}:g);
  const realGpus=gpus.filter(g=>!g.virtual), gpuMetrics=h.gpu_metrics||[];
  const temps=document.temps||h.temps||[], fans=document.fans||h.fans||[];
  const cpuSensor=temps.find(t=>/coretemp|k10temp|zenpower|cpu_thermal/i.test(t.chip||'')&&/Package|Tctl|Tdie|CPU/i.test(t.label||t.chip||''))||temps.find(t=>/coretemp|k10temp|zenpower|cpu_thermal/i.test(t.chip||''));
  const cpuModel=cpu.model||'Модель CPU не передана', model=cpuModel.replace(/\s+(?:\d+-Core Processor|with Radeon.*|CPU @.*)$/,'').replace(/\(R\)|\(TM\)/g,'').trim();
  const allNics=(h.nics||[]).filter(n=>n.hardware!==false);
  // Several Windows interface instances can refer to one physical adapter.
  // Group only exact nonempty PnP IDs, preserving every instance in the detail list.
  const nicGroups=new Map();
  for(const n of allNics){const key=n.device_id||n.iface;if(!nicGroups.has(key))nicGroups.set(key,[]);nicGroups.get(key).push(n);}
  const nics=[...nicGroups.values()].map(instances=>{
    const n=instances.find(x=>/^(up)$/i.test(x.state))||instances.find(x=>!x.hidden&&!/not present/i.test(x.state))||instances[0];
    return {...n,kind:n.kind||'unknown',instances,up:/^up$/i.test(n.state),label:n.kind==='wifi'?'Wi-Fi':n.kind==='ethernet'?'Ethernet':n.iface,speedText:speed(n.speed_bps??(n.speed?n.speed*1e6:null))};
  }).sort((a,b)=>Number(b.up)-Number(a.up)||(a.kind==='wifi'?-1:b.kind==='wifi'?1:0));
  const parts=[];
  const cpuStatus=cpu.model?'Определён':'Нет данных';
  parts.push(row('cpu',cpuModel,'Процессор',[
    ['Ядра / потоки',`${value(cpu.cores)} / ${value(cpu.threads)}`],['Сокеты',value(cpu.sockets)],
    ['Частота ОС / DMI',cpu.max_mhz?`${Number(cpu.max_mhz)/1000} ГГц`:'Не передано'],['Температура',cpuSensor?`${cpuSensor.c} °C`:'Нет доступного датчика'],
  ],{status:cpuStatus,source:cpu.source||source,note:'Модель и топология из системного инвентаря. Частота ОС/DMI не является текущей частотой или гарантированным пределом Boost.'}));
  const installed=memory.installed||modules.reduce((n,m)=>n+(m.size_bytes||0),0);
  parts.push(row('ram','Оперативная память','Память',[
    ['Установлено',bytes(installed)],['Видно ОС',bytes(memory.total)],['Модули / слоты',`${modules.length} / ${value(memory.slots)}`],
    ...modules.map(m=>[`${m.bank?m.bank+' · ':''}${m.slot||'Слот без имени'}`,`${bytes(m.size_bytes)} · ${m.type||'тип неизвестен'} · ${m.speed||'—'}`]),
  ],{status:modules.length?'Определён':'Частично',source:windows?'Win32_PhysicalMemory / SMBIOS':'DMI type 17',note:'Подписи слотов сохранены из источника. При одинаковом DeviceLocator каналы различаются по BankLabel. Положение на рисунке не обозначает физический слот.'}));
  for(let i=0;i<modules.length;i++){const m=modules[i];parts.push(row(`dimm:${[m.bank,m.slot].filter(Boolean).join(':')||i}`,`${m.bank?m.bank+' · ':''}${m.slot||'DIMM '+(i+1)}`,'Модуль памяти',[['Объём',bytes(m.size_bytes)],['Тип',value(m.type)],['Скорость DMI',value(m.speed)],['Производитель',value(m.vendor)],['Part number',value(m.part)]],{source:m.source||'DMI'}));}
  const slotRecords=memory.slot_records?.length?memory.slot_records.map((slot,i)=>{
    const module=modules.find(m=>m.slot===slot.slot&&(!slot.bank||m.bank===slot.bank));
    return {...slot,module,id:`slot:${slot.id||[slot.bank,slot.slot].filter(Boolean).join(':')||i}`,label:[slot.bank,slot.slot].filter(Boolean).join(' · '),size:module?.size_bytes||slot.size_bytes||0};
  }):modules.length?[
    ...modules.map((m,i)=>({id:`slot:${[m.bank,m.slot].filter(Boolean).join(':')||i}`,slot:m.slot,bank:m.bank,label:[m.bank,m.slot].filter(Boolean).join(' · '),size:m.size_bytes,module:m,state:'populated'})),
    ...Array.from({length:Math.min(32,Math.max(0,(memory.slots||modules.length)-modules.length))},(_,i)=>({id:`slot:empty:${i}`,label:`Свободный слот ${i+1} · маркировка не передана`,state:'empty',countOnly:true})),
  ]:[];
  for(const slot of slotRecords)parts.push(row(slot.id,slot.label||'Слот без подписи','Слот памяти',[
    ['Состояние',slot.state==='empty'?'Пустой':slot.state==='populated'?'Установлен модуль':'Не определено'],['Device Locator',value(slot.slot)],['Bank Locator',value(slot.bank)],['Объём',slot.state==='empty'?'—':bytes(slot.size)],
    ...(slot.module?[['Тип',value(slot.module.type)],['Скорость DMI',value(slot.module.speed)],['Производитель',value(slot.module.vendor)],['Part number',value(slot.module.part)]]:[]),
  ],{status:slot.state==='unknown'?'Частично':'Определён',source:slot.source||'DMI / CIM',note:slot.countOnly?'Количество свободных мест известно, но их физические подписи не переданы.':`Это подпись из прошивки: ${slot.label}. Порядок на рисунке следует таблице SMBIOS/DMI; для размещения на самой плате используйте её маркировку.`}));
  parts.push(row('gpu','Графические адаптеры','Графика',gpus.map(g=>[g.virtual?'Виртуальный адаптер':'GPU',g.name]),{status:gpus.length?'Определён':'Нет данных',source:windows?'Win32_VideoController':'lspci',note:'Виртуальные дисплейные адаптеры перечислены отдельно и не рисуются как физические видеокарты. Объём VRAM берётся из драйвера, а не из ограниченного поля AdapterRAM.'}));
  gpus.forEach((g,i)=>{const metric=gpuMetrics.find(x=>x.name===g.name);parts.push(row(`gpu:${g.id||g.name||i}`,g.name,g.virtual?'Виртуальная графика':'Видеокарта',[
    ['Драйвер',value(g.driver)],['Температура',metric?.temp!=null?`${metric.temp} °C`:'Нет данных'],['Память драйвера',metric?.memory_bytes?bytes(metric.memory_bytes):'Нет данных'],['Вентилятор',metric?.fan_percent!=null?`${metric.fan_percent} %`:'Нет данных'],
  ],{source:[g.source,metric?.source].filter(Boolean).join(' + ')}));});
  parts.push(row('nic','Сетевые адаптеры','Сеть',nics.map(n=>[n.iface,`${n.label} · ${n.speedText||n.state||'состояние неизвестно'}`]),{status:nics.length?'Определён':'Нет данных',source:windows?'MSFT_NetAdapter':'sysfs net',note:`${allNics.length} физических интерфейсов ОС, ${nics.length} устройств после группировки по точному PnP ID. Виртуальные интерфейсы не превращаются в разъёмы платы.`}));
  if(h.os_interfaces?.length){const group=parts.find(p=>p.id==='nic');group.status='Частично';group.facts=h.os_interfaces.map(n=>[n.name,'Тип и скорость связи не переданы']);group.note='Агент передаёт интерфейсы ОС и счётчики трафика. Их физический тип неизвестен; виртуальные интерфейсы не рисуются как разъёмы платы.';}
  nics.forEach((n,i)=>parts.push(row(`nic:${n.device_id||n.iface||i}`,n.description||n.iface,'Сеть',[
    ['Тип',n.label],['Интерфейс',n.iface],['Состояние',value(n.state)],['Скорость связи',n.speedText||'Нет данных'],['Драйвер',value(n.driver)],...n.instances.filter(x=>x!==n&&x.iface!==n.iface).map(x=>['Также в ОС',`${x.iface} · ${x.state}`])
  ],{source:n.source||source})));
  parts.push(row('chipset',h.board||'Материнская плата','Плата и контроллеры',[
    ['Плата',value(h.board)],['BIOS',value(h.bios)],['Производитель',value(h.vendor)],['Чипсет','Отдельная модель не подтверждена'],
  ],{status:h.board?'Частично':'Нет данных',source:windows?'Win32_BaseBoard / Win32_BIOS':'sysfs DMI',note:'Полное имя платы получено от прошивки. Название чипсета из строки модели не выдаётся за результат отдельного аппаратного определения.'}));

  const actualDisks=physical.filter(d=>!d.virtual&&d.kind!=='virtual');
  parts.push(row('disk','Диски и тома','Накопители',physical.map(d=>[d.model||d.dev,`${d.virtual||d.kind==='virtual'?'Виртуальный':d.kind?.toUpperCase()||'Тип неизвестен'} · ${diskSize(d.size)}${d.volumes?.length?' · '+d.volumes.join(', '):''}`]),{status:physical.length?'Определён':'Нет данных',source:windows?'Win32_DiskDrive + Storage + CIM associations':'lsblk + smartctl',note:`${actualDisks.length} физических и ${physical.length-actualDisks.length} виртуальных накопителей. Буквы томов связаны с устройствами через ассоциации ОС; количество томов не используется для подсчёта дисков.`}));
  if(h.volumes?.length){const group=parts.find(p=>p.id==='disk');group.name='Логические тома';group.kind='Тома файловой системы';group.status='Частично';group.facts=h.volumes.map(v=>[v.path,`${bytes(v.total)} · ${v.total?Math.round(v.used/v.total*100)+' % занято':'объём неизвестен'}`]);group.note='Этот агент передаёт тома файловой системы. Физические накопители, их тип и SMART пока неизвестны.';}
  physical.forEach((d,i)=>{const reliability=h.reliability?.find(r=>r.id===d.id),temperature=d.temp??reliability?.temp;parts.push(row(`disk:${d.id||d.dev||d.model||i}`,d.model||d.dev,d.virtual?'Виртуальный диск':'Накопитель',[
    ['Тип / объём',`${d.kind||'Не определён'} · ${diskSize(d.size)}`],['Интерфейс',value(d.transport)],['Тома',d.volumes?.join(', ')||(d.volume_mapping==='collected'?'Нет томов с буквой':'Привязка не передана')],['Температура',temperature!=null?`${temperature} °C`:'Нет данных'],['Износ',d.wear!=null?`${d.wear} %`:reliability?.wear!=null?`${reliability.wear} % (ОС)`:'Нет данных'],['Состояние',d.health_status||(d.health===true?'SMART: passed':d.health===false?'SMART: failed':'Нет данных')],['Прошивка',value(d.firmware)]
  ],{source:d.source||'lsblk + smartctl',note:reliability?.reason?`Счётчики SMART/надёжности недоступны: ${reliability.reason}`:d.virtual?'Это виртуальное блочное устройство; оно не учитывается как физический накопитель.':'Тома и показатели относятся только к этому устройству.'}));});
  const unknown=devices.filter(d=>d.status==='unrecognized');
  const extras=[];
  for(const [i,d] of devices.entries()){
    const id=`device:${d.id||[d.bus,d.address,d.vendor_id,d.device_id].join(':')||i}`,unknown=d.status==='unrecognized',name=d.name||`${d.bus?.toUpperCase()||''}-устройство · модель неизвестна`;
    parts.push(row(id,name,d.kind||'Устройство',[
      ['Шина',value(d.bus)],['Адрес',value(d.address)],['Vendor / Device',`${value(d.vendor_id)} / ${value(d.device_id)}`],['Класс',value(d.kind||d.class_id)],['Драйвер',value(d.driver)],...(d.problem_code!=null?[['Код PnP',String(d.problem_code)]]:[]),
    ],{status:unknown?'Не определён':'Определён',unknown,problemCode:d.problem_code,source:d.source||source,raw:JSON.stringify(d,null,2),rawId:d.id,note:unknown?'Запись обнаружена системой. Неопознанная модель сохраняется вместе с ID, классом и драйвером. Статус определения не заменяет состояние здоровья.':undefined}));
    extras.push([id,/audio|sound|media/i.test(d.kind)?'audio':d.bus==='usb'?'usb':'cpu',name,`${d.bus?.toUpperCase()||''} · ${d.address||d.device_id}`]);
  }
  extras.sort((a,b)=>Number(parts.find(p=>p.id===b[0]).unknown)-Number(parts.find(p=>p.id===a[0]).unknown));
  if(unknown.length){const p=parts.find(p=>p.rawId===unknown[0].id);parts.push({...p,id:'unknown',groupOnly:true});}
  const unavailable=[];
  if(!Array.isArray(h.devices))unavailable.push('Полный PCI/USB-инвентарь не передан');
  if(!cpuSensor)unavailable.push('Температура CPU недоступна');
  if(!modules.length)unavailable.push('Модули DIMM не переданы');
  if(!realGpus.length)unavailable.push('Физическая GPU не определена');
  if(windows&&h.reliability?.some(r=>r.status==='unavailable'))unavailable.push('Счётчики SMART Windows недоступны текущему пользователю');
  for(const [section,s] of Object.entries(h.sources||{})){if(s.status==='unavailable')unavailable.push(`Источник ${section}: ${s.reason||'недоступен'}`);}
  const ram=slotRecords.length?slotRecords.map(s=>s.state==='populated'?bytes(s.size).replace(' ГБ',''):null):null;
  const emptySlots=slotRecords.filter(s=>s.state==='empty').length;
  const hidePeripheralUnknown=!!(cpu.model&&modules.length&&actualDisks.length);
  const boardDisks=actualDisks.slice(0,hidePeripheralUnknown?3:2);
  const diskLabels=boardDisks.map(d=>`${d.kind?.toUpperCase()||'Диск'} · ${diskSize(d.size)}`);
  const cpuBrand=/AMD/i.test(model)?'AMD':/Intel/i.test(model)?'Intel':'CPU', cpuName=model.replace(/^(?:Intel|AMD)\s*/,'');
  return {name,sub:short(model.replace(/^Intel\s*/,''),27),description:`${windows?'Windows':'Linux / Proxmox'} · ${model} · ${bytes(installed||memory.total)}`,board:h.board||name,cpuLines:[cpuBrand,short(cpuName,19),''],cpuSummary:`${cpu.cores||'—'} ${plural(cpu.cores||0,['ядро','ядра','ядер'])} · ${cpu.threads||'—'} ${plural(cpu.threads||0,['поток','потока','потоков'])}`,temp:cpuSensor?`${Math.round(cpuSensor.c)}°`:null,cpuTemperature:cpuSensor?.c??null,cpuCritical:cpuSensor?.crit??100,cpuMaximum:cpuSensor?.max??null,memory:bytes(installed||memory.total),memoryIsInstalled:installed>0,gpuInventory:Array.isArray(h.gpus),ram,slotRecords,ramCaption:`${modules.length} из ${memory.slots??slotRecords.length} занято · ${emptySlots} свободно`,ramType:modules[0]?.type||'тип —',gpu:realGpus.length?realGpus.map(g=>g.name).join(' + '):null,gpuNames:realGpus.map(g=>short(g.name.replace(/^NVIDIA\s*/,''),22)),nics:nics.slice(0,2).map(n=>`${n.kind==='wifi'?'Wi-Fi':n.label} · ${n.speedText||(/down|disconnected/i.test(n.state)?'нет связи':n.state||'—')}`),nicKinds:nics.slice(0,2).map(n=>n.kind),disks:diskLabels,diskNames:boardDisks.map(d=>short(d.model||d.dev,21)),diskInfo:boardDisks.map(d=>{const r=h.reliability?.find(x=>x.id===d.id),temp=d.temp??r?.temp;return `${temp!=null?temp+' °C':'t° нет данных'}${d.wear!=null?' · износ '+d.wear+' %':''}`;}),moreDisks:physical.length-diskLabels.length,volumes:h.volumes||[],parts,extras,sensors:[...temps.map(t=>({name:`${t.chip} · ${t.label}`,value:`${t.c} °C`,source:t.source||'sysfs hwmon'})),...fans.map(f=>({name:f.label,value:`${f.rpm} об/мин`,source:f.source||'sysfs hwmon'})),...gpuMetrics.map(g=>({name:g.name,value:`${g.temp??'—'} °C · ${bytes(g.memory_bytes)} VRAM`,source:g.source}))],missing:unavailable.length?unavailable.join('. ')+'.':'Основной инвентарь собран. Непереданные поля отмечены в подробностях.',unknownAddress:unknown[0]?.address,unknownBus:unknown[0]?.bus?.toUpperCase(),unknownCount:unknown.length,unknownLabel:unknown.length?short(unknown[0].name||'Модель не определена',27):null,hidePeripheralUnknown,collected:true,timestamp:document.ts||h.ts,deviceCount:Array.isArray(h.devices)?devices.length:undefined,source};
}

function legacyMemoryBytes(size) {
  const match=String(size||'').match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
  return match?Number(match[1])*1024**({KB:1,MB:2,GB:3,TB:4}[match[2].toUpperCase()]):0;
}
export function hardwareForMachine(machine) {
  const host=machine.pve, snapshot=machine.pc?.current;
  let document;
  if(host&&!machine.guest){document={hardware:{...(host.hardware||{}),agent:host.hardware?.agent||host.current?.versions?.agent},disks:host.current?.disks||[],temps:host.current?.temps||[],fans:host.current?.fans||[],ts:host.hardware?.ts||host.current?.ts};}
  else if(snapshot){
    const hw=snapshot.hardware;
    document=hw?{...hw,ts:hw.ts||snapshot.ts}:{os:snapshot.os,ts:snapshot.ts,source:`pc-agent ${snapshot.agent||''}`,cpu:{model:snapshot.cpu?.model,threads:snapshot.cpu?.cores},memory:{total:snapshot.memory?.total},volumes:snapshot.disks||[],os_interfaces:(snapshot.network||[]).filter(n=>!n.aggregate),nics:[]};
  }
  const view=machineFromHardware(machine.kind==='pc'?'pc':host?.id||machine.key,document,machine.pc?.error||host?.error);
  view.name=machine.name;
  view.timestamp=document?.ts;
  view.offline=!machine.online;
  view.agent=document?.hardware?.agent||document?.agent||snapshot?.agent;
  if(snapshot&&!snapshot.hardware)view.missing+=' Для полного инвентаря обновите pc-agent до 1.2.0 или новее.';
  return view;
}
