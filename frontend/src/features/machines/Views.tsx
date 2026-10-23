import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import { TimeChart } from "../../components/charts/TimeChart";
import { usePve, useSaved } from "../pve/context";
import { usePc } from "../pc/context";
import { Controls } from "../pc/Actions";
import { ActionButtons } from "../pve/Actions";
import { ContainerActions, AppBadges } from "../pc/Workloads";
import { Ports, shortImage } from "../pc/parts";
import { containersOf, outdated } from "../pc/model";
import { ago, backupFailed, bits, bytes, mainStorage, percent, proxmoxURL, ratio, uptime, usePoll } from "../pve/model";
import { Bar, Empty } from "../pve/parts";
import { Chart } from "../pve/ui";
import { BackupList } from "../pve/Storage";
import { EventCenter, type MonitoringEvent } from "../monitoring/EventCenter";
import { Board } from "./Board";
import { combinedEvents } from "./events";
import { containerLink, flatten, machineContainers, machineRoute, machineTree, type Machine } from "./model";

export function useMachineTree() {
  const pve = usePve(), pc = usePc();
  return useMemo(() => { const roots=machineTree(pve.hosts, pc.computers, pc.placement?.machines); if(pve.standalone) flatten(roots).forEach(m=>m.standalone=true); return roots; }, [pve.hosts, pc.computers, pc.placement, pve.standalone]);
}
const icons: Record<Machine["kind"], IconName> = { server: "servers", pc: "computer", vm: "virtualMachine", wsl: "terminal" };
const labels = { server: "Proxmox", pc: "ПК", vm: "VM", wsl: "WSL" };
export function Avatar({ m }: { m: Machine }) { return <span className={`mc-avatar ${m.kind}`} style={m.kind === "server" ? { ["--hue" as string]: [28,205,155][Math.max(0, Number(m.pve?.id.replace(/\D/g,""))-1) % 3] } : undefined}><Icon name={icons[m.kind]} size={19} /></span>; }
export function MachineName({ m, compact = false, heading = false }: { m: Machine; compact?: boolean; heading?: boolean }) {
  const { hide } = usePve();
  return <div className="mc-name"><Avatar m={m} /><div>{heading ? <h1 className="mc-title"><a href={`#/${machineRoute(m)}`}>{m.name}</a></h1> : <a href={`#/${machineRoute(m)}`}>{m.name}</a>}<span className={`mc-dot${m.online ? "" : " off"}`} title={m.online ? "Работает" : "Выключена или нет связи"} />{!compact && <small>{labels[m.kind]}{m.guest ? ` ${m.guest.vmid}` : ""} · {m.wsl ? "в общей нагрузке ПК" : hide ? "Адрес скрыт" : m.pc?.address || (m.guest ? m.guest.ips?.[0] || "IP неизвестен" : m.pve?.address || "IP неизвестен")}</small>}</div></div>;
}
function stats(m: Machine) {
  const pc = m.pc?.current, g = m.guest, n = m.pve?.current?.node, disk = m.kind === "server" ? mainStorage(m.pve?.current || null) : null;
  const disks = pc?.disks.filter(d => d.total > 0) || [], worst = [...disks].sort((a,b)=> b.used/b.total-a.used/a.total)[0];
  return { cpu: m.wsl ? null : pc?.cpu.percent ?? g?.cpu ?? (m.kind === "server" ? n?.cpu : pc?.cpu.percent) ?? null,
    mem: m.wsl ? null : pc?.memory.used ?? g?.mem ?? n?.mem.used, total: pc?.memory.total ?? g?.maxmem ?? n?.mem.total,
    diskUsed: worst?.used ?? disk?.used ?? g?.disk, diskTotal: worst?.total ?? disk?.total ?? g?.maxdisk,
    uptime: m.wsl ? undefined : g?.uptime ?? (m.kind === "server" ? n?.uptime : pc?.uptime) };
}
function historyOf(m: Machine, pve: ReturnType<typeof usePve>, pc: ReturnType<typeof usePc>) {
  const since = Date.now()/1000 - 86400;
  if (m.pc && !m.wsl) return (pc.history.data[m.pc.id]?.points || []).filter(p=>p.t>=since).map(p=>({t:p.t,cpu:p.cpu,mem:p.mem_used,rx:p.network_valid === false ? null : p.net_rx_bps/8,tx:p.network_valid === false ? null : p.net_tx_bps/8}));
  if (m.guest) return (pve.history[m.pve!.id]?.guests?.[m.guest.vmid] || []).filter(p=>p[0]>=since).map(p=>({t:p[0],cpu:p[1],mem:p[2],rx:null,tx:null}));
  if (m.kind === "server") return (pve.history[m.pve!.id]?.points || []).filter(p=>p.t>=since).map(p=>({t:p.t,cpu:p.cpu,mem:p.mem,rx:p.rx,tx:p.tx}));
  return [];
}
type Attention = { key: string; title: string; detail: string; link: string; icon: IconName };
function attentionOf(roots: Machine[]): Attention[] {
  return flatten(roots).flatMap(m => {
    const rows: Attention[] = [], h=m.pve, pc=m.pc;
    if (!m.online && m.kind !== "wsl" && !m.guest || m.pc && m.online && !m.pc.online) rows.push({key:`${m.key}:offline`,title:`${m.name}: нет связи`,detail:pc?.error || h?.error || "Агент недоступен",link:`#/${machineRoute(m)}`,icon:"network"});
    if (m.kind === "server" && h?.current) {
      const c=h.current, allocated=c.guests.filter(g=>!g.template).reduce((s,g)=>s+g.maxmem,0), cpus=c.guests.filter(g=>!g.template).reduce((s,g)=>s+g.cpus,0);
      if (ratio(allocated,c.node.mem.total)>=85 || cpus>c.node.threads) rows.push({key:`${m.key}:allocation`,title:`${m.name}: ресурсы закреплены за машинами`,detail:`Память ${bytes(allocated)} из ${bytes(c.node.mem.total)} · CPU ${cpus} из ${c.node.threads}`,link:"#/pve/resources",icon:"overview"});
      if (c.updates) rows.push({key:`${m.key}:updates`,title:`${m.name}: ${c.updates} обновлений`,detail:"Доступны обновления пакетов",link:`#/${machineRoute(m)}?tab=config`,icon:"refresh"});
      if (c.backups.some(backupFailed)) rows.push({key:`${m.key}:backups`,title:`${m.name}: ошибка резервной копии`,detail:"Проверьте журнал копирования",link:"#/pvestorage",icon:"alert"});
      if (c.failed_units.length) rows.push({key:`${m.key}:units`,title:`${m.name}: ошибки служб`,detail:c.failed_units.join(", "),link:`#/${machineRoute(m)}?tab=config`,icon:"alert"});
      for (const d of c.storage.filter(d=>d.active&&ratio(d.used,d.total)>=85)) rows.push({key:`${m.key}:${d.name}`,title:`${m.name}: хранилище ${d.name} ${percent(ratio(d.used,d.total))}`,detail:`Свободно ${bytes(d.total-d.used)}`,link:"#/pvestorage",icon:"system"});
    }
    if (!m.wsl) for (const d of pc?.current?.disks.filter(d=>d.total&&ratio(d.used,d.total)>=85) || []) rows.push({key:`${m.key}:${d.path}`,title:`${m.name}: диск ${d.path} ${percent(ratio(d.used,d.total))}`,detail:`Свободно ${bytes(d.free)}`,link:`#/${machineRoute(m)}?tab=config`,icon:"system"});
    return rows;
  });
}
export function Overview({ roots }: { roots: Machine[] }) {
  const pve=usePve(), pc=usePc(), all=flatten(roots), machines=all.filter(m=>m.kind!=="wsl"), rows=containersOf(pc.computers), attention=attentionOf(roots), copies=pve.hosts.flatMap(h=>h.current?.backups || []), last=[...copies].filter(b=>b.status==="OK").sort((a,b)=>b.start-a.start)[0];
  const health: {icon: IconName; value:string; label:string; link:string; warn?:boolean}[] = [
    {icon:"activity",value:`${machines.filter(m=>m.online).length} / ${machines.length}`,label:"машин на связи",link:"#/pveguests"},
    {icon:"dms",value:pc.computers.length ? `${rows.filter(r=>r.c.state==="running").length} / ${rows.length}` : "—",label:"контейнеров работает",link:"#/pve/containers"},
    {icon:"alert",value:String(attention.length),label:"требуют внимания",link:"#/pve/events",warn:!!attention.length},
    {icon:"logs",value:last ? ago(last.start) : "Нет данных",label:"последняя копия",link:"#/pvestorage"}];
  return <><div className="mc-health">{health.map(s=><a className={`mc-health-card${s.warn ? " warn" : ""}`} key={s.label} href={s.link}><span className="mc-health-icon"><Icon name={s.icon} size={21}/></span><div><b>{s.value}</b><small>{s.label}</small></div></a>)}</div>
    <div className="mc-overview"><section className="pv-card"><h2>Что на чём работает <a href="#/pveguests">Все устройства <Icon name="chevronRight" size={14}/></a></h2><div className="mc-topology">{roots.filter(m=>!pve.query || flatten([m]).some(v=>`${v.name} ${v.pc?.address || v.pve?.address}`.toLowerCase().includes(pve.query.toLowerCase()))).map(m=><article className="mc-topo-node" key={m.key}><MachineName m={m} compact/>{m.children.filter(c=>c.kind!=="wsl"||c.online).map(c=><div className={`mc-topo-child${c.online ? "" : " off"}`} key={c.key}><MachineName m={c} compact/>{c.pc && <a className="mc-count" href={containerLink(c)}>{machineContainers(c).length} конт.</a>}</div>)}{m.children.some(c=>c.kind==="wsl"&&!c.online) && <details className="mc-more"><summary>Ещё {m.children.filter(c=>c.kind==="wsl"&&!c.online).length} WSL остановлено</summary>{m.children.filter(c=>c.kind==="wsl"&&!c.online).map(c=><div className="mc-topo-child off" key={c.key}><MachineName m={c} compact/></div>)}</details>}{!m.children.length && <small className="mc-muted">Вложенных машин нет</small>}</article>)}</div></section>
    <section className="pv-card"><h2>Требует внимания <a href="#/pve/events">События <Icon name="chevronRight" size={14}/></a></h2><div className="mc-attention">{attention.map(a=><a className="mc-alert-row" key={a.key} href={a.link}><span><Icon name={a.icon} size={18}/></span><div><b>{a.title}</b><small>{a.detail}</small></div><Icon name="chevronRight" size={15}/></a>)}{!attention.length && <p className="mc-muted">Всё в порядке</p>}</div></section></div></>;
}
function DeviceRow({ m, tile=false }: { m: Machine; tile?:boolean }) {
  const pve=usePve(), pc=usePc(), s=stats(m), points=historyOf(m,pve,pc), containers=machineContainers(m);
  return <div className={`mc-device-row ${m.parent ? "child" : "physical"}${m.online ? "" : " off"}${tile ? " tile" : ""}`}><MachineName m={m}/>
    <div className="mc-metric">{m.wsl ? <small>в общей нагрузке ПК</small> : <><span>{percent(s.cpu)}</span><Chart title={`CPU ${m.name} · сутки`} times={points.map(p=>p.t)} values={points.map(p=>p.cpu)} format={percent} compact/></>}</div>
    <div className="mc-metric">{m.wsl ? "—" : <><span>{bytes(s.mem)} / {bytes(s.total)}</span><Bar thin value={ratio(s.mem || 0,s.total || 0)} tone={ratio(s.mem || 0,s.total || 0)>=85 ? "warn" : "ok"}/></>}</div>
    <div className="mc-metric">{m.wsl ? "—" : <><span>{s.diskTotal ? `${percent(ratio(s.diskUsed || 0,s.diskTotal))} из ${bytes(s.diskTotal)}` : "Нет данных"}</span>{!!s.diskTotal && <Bar thin value={ratio(s.diskUsed || 0,s.diskTotal)} tone={ratio(s.diskUsed || 0,s.diskTotal)>=85 ? "warn" : "ok"}/>}</>}</div>
    <div>{m.pc ? <a className="mc-link" href={containerLink(m)}>{containers.length} контейнеров <Icon name="chevronRight" size={13}/></a> : m.kind==="server" ? <a className="mc-link" href={containerLink(m)}>{m.children.reduce((n,c)=>n+machineContainers(c).length,0)} контейнеров <Icon name="chevronRight" size={13}/></a> : <small>Агента нет</small>}</div><span className="mc-muted">{uptime(s.uptime)}</span><a href={`#/${machineRoute(m)}`} aria-label={`Открыть ${m.name}`}><Icon name="chevronRight" size={16}/></a></div>;
}
export function Devices({ roots, route }: { roots: Machine[]; route: string }) {
  const pve=usePve(), [view,setView]=useSaved("homenet.machines.devices-view","tree"), [filter,setFilter]=useState("all");
  const params=new URLSearchParams(route.split("?")[1]), scope=params.get("parent"), scoped=scope ? new Set(flatten(flatten(roots).find(m=>m.key===scope)?.children || []).map(m=>m.key)) : null;
  const preset=params.get("filter") || "all";
  useEffect(()=>setFilter(preset),[preset]);
  const match=(m: Machine) => (!scoped || scoped.has(m.key)) && (filter==="all" || filter==="servers"&&m.kind==="server" || filter==="pc"&&m.kind==="pc" || filter==="vm"&&m.kind==="vm" || filter==="wsl"&&m.kind==="wsl" || filter==="off"&&!m.online) && (!pve.query || `${m.name} ${m.pc?.address || ""} ${m.guest?.vmid || ""} ${m.guest?.ips?.join(" ") || ""} ${m.pve?.address || ""}`.toLowerCase().includes(pve.query.toLowerCase()));
  const render=(m: Machine) => { const children=flatten(m.children).filter(match), visible=match(m); if(!visible&&!children.length) return null;
    const stopped=children.filter(c=>c.kind==="wsl"&&!c.online), shown=children.filter(c=>!stopped.includes(c));
    return <div className={view==="tiles" ? "pv-card mc-device-tile" : "mc-device-group"} key={m.key}>{(visible || children.length>0) && <DeviceRow m={m} tile={view==="tiles"}/>} {shown.map(c=><DeviceRow key={c.key} m={c} tile={view==="tiles"}/>)}{stopped.length>0&&<details className="mc-more mc-stopped" open={filter==="off" || undefined}><summary>Показать {stopped.length} остановленных WSL</summary>{stopped.map(c=><DeviceRow key={c.key} m={c} tile={view==="tiles"}/>)}</details>}</div>;
  };
  return <><div className="mc-tools"><div className="mc-chips">{[["all","Все"],...(!pve.standalone ? [["servers","Серверы"],["pc","ПК"],["vm","VM"]] : []),["wsl","WSL"],["off","Выключенные"]].map(([id,label])=><button key={id} className={`pv-chip${filter===id ? " is-on" : ""}`} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div><div className="mc-segment" aria-label="Вид устройств">{[["tree","Дерево"],["tiles","Плитки"]].map(([id,label])=><button key={id} aria-pressed={view===id} onClick={()=>setView(id)}>{label}</button>)}</div></div>
    {flatten(roots).some(match) ? <div className={view==="tree" ? "mc-tree" : "mc-device-tiles"}>{view==="tree"&&<div className="mc-device-row mc-table-head"><span>Устройство</span><span>CPU · сутки</span><span>Память</span><span>Диск</span><span>Контейнеры</span><span>Работает</span><span/></div>}{roots.map(render)}</div> : <Empty title="Ничего не найдено">Измените поиск или фильтры.</Empty>}</>;
}
export function Containers({ roots, route }: { roots: Machine[]; route: string }) {
  const pc=usePc(), pve=usePve(), all=flatten(roots), params=new URLSearchParams(route.split("?")[1]), host=params.get("host"), context=params.get("context"), server=params.get("server"), missing=params.get("machine"), [filter,setFilter]=useState("all");
  const [expanded,setExpanded]=useState<string[]>([]), q=pve.query.toLowerCase().trim();
  const rows=containersOf(pc.computers).filter(r=>(!host||r.h.id===host)&&(!context||r.d.context===context)&&(!server||all.some(m=>m.pc?.id===r.h.id&&m.pve?.id===server))&&!missing);
  const visible=rows.filter(r=>(filter==="all" || filter==="running"&&r.c.state==="running" || filter==="stopped"&&r.c.state!=="running")&&(!q||[r.h.name,r.c.name,r.c.image,r.c.ports,r.d.context].some(s=>s.toLowerCase().includes(q))));
  const groups=[...visible.reduce((map,r)=>{const key=`${r.h.id}/${r.d.context}`;map.set(key,[...(map.get(key)||[]),r]);return map;},new Map<string, typeof rows>())];
  return <><div className="mc-tools"><div className="mc-chips">{[["all","Все"],["running","Работают"],["stopped","Остановлены"]].map(([id,label])=><button className={`pv-chip${filter===id ? " is-on" : ""}`} key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div><span className="mc-muted">Показано {visible.length} из {rows.length}</span>{(host||context||server||missing)&&<a className="mc-link" href={pve.standalone ? "#/pcdocker" : "#/pve/containers"}>Все машины <Icon name="close" size={13}/></a>}</div>
    {groups.map(([key,group])=>{const {h,d}=group[0], m=all.find(m=>m.pc?.id===h.id&&!m.wsl), parents=m?.parent ? `${m.parent.name} › ` : "", label=`${parents}${m?.name || h.name}${d.context.startsWith("wsl:") ? ` › ${d.context.slice(4)}` : ""}`, more=group.length>6&&!expanded.includes(key); return <details className="mc-container-group" key={key} open><summary><Icon name="chevronRight" size={14}/><Icon name="dms" size={16}/>{label}<span className="mc-muted">{group.filter(r=>r.c.state==="running").length} / {group.length}</span></summary><div className="mc-container-scroll"><table className="mc-container-table"><thead><tr><th>Состояние</th><th>Имя</th><th>Образ</th><th>Порты</th><th>Статус</th><th>Приложение</th><th>Действия</th></tr></thead><tbody>{group.slice(0,more?6:undefined).map(row=><tr key={row.c.id} className={outdated(row.h) ? "off" : ""}><td><span className={`mc-dot${row.c.state==="running" ? "" : " off"}`} title={row.c.state}/></td><td><button className="mc-text-button" onClick={()=>pc.openContainer({host:h.id,context:d.context,id:row.c.id})}>{row.c.name}</button></td><td><span className="mc-image" title={row.c.image}>{shortImage(row.c.image)}</span></td><td><Ports value={row.c.ports}/></td><td className="mc-muted">{row.c.status}</td><td><AppBadges row={row}/></td><td><ContainerActions row={row}/></td></tr>)}</tbody></table></div>{group.length>6&&<button className="mc-show-all" onClick={()=>setExpanded(old=>old.includes(key)?old.filter(k=>k!==key):[...old,key])}>{more ? `Показать все ${group.length} контейнеров` : "Свернуть список"}</button>}</details>;})}
    {!groups.length&&<Empty title="Контейнеры не найдены">{pc.computers.length ? "Измените фильтры. Для VM без pc-agent контейнеры неизвестны." : "Модуль компьютеров недоступен или не настроен."}</Empty>}
    {pc.computers.some(h=>h.current?.docker.some(d=>!d.available))&&<details className="mc-more"><summary>Недоступные окружения Docker</summary>{pc.computers.flatMap(h=>(h.current?.docker || []).filter(d=>!d.available).map(d=><p key={`${h.id}/${d.context}`}>{h.name} › {d.context}: {d.error || "нет данных"}</p>))}</details>}</>;
}
export function Hardware({ roots }: { roots: Machine[] }) {
  const {query}=usePve(), [filter,setFilter]=useState("all");
  return <><div className="mc-chips">{[["all","Все"],["server","Серверы"],["pc","ПК"]].map(([id,label])=><button className={`pv-chip${filter===id ? " is-on" : ""}`} key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label} · {roots.filter(m=>id==="all"||m.kind===id).length}</button>)}</div><div className="mc-hardware">{roots.filter(m=>(filter==="all"||m.kind===filter)&&(!query||m.name.toLowerCase().includes(query.toLowerCase()))).map(m=>{
    const disk=stats(m), warning=!!disk.diskTotal&&ratio(disk.diskUsed || 0,disk.diskTotal)>=85;
    return <article className="pv-card" key={m.key}><div className="mc-hardware-head"><MachineName m={m}/>{warning&&<span className="mc-badge warn">диск {percent(ratio(disk.diskUsed || 0,disk.diskTotal || 0))}</span>}</div><Board machine={m}/></article>;
  })}</div></>;
}

export function Events({ pcEnabled }: { pcEnabled:boolean }) { const pve=usePve(), pc=usePc(), host=useMemo(()=>combinedEvents(pve.host,pc.host,pcEnabled),[pve.host,pc.host,pcEnabled]); return <EventCenter host={host} service="pve" hosts={[...pve.hosts.map(h=>({id:`pve:${h.id}`,name:h.name})),...pc.computers.map(h=>({id:`pc:${h.id}`,name:h.name}))]} enabled defaultExpanded/>; }

export function MachinePage({ m, onBack }: { m: Machine; onBack:()=>void }) {
  const pve=usePve(), pc=usePc(), initial=new URLSearchParams(location.hash.split("?")[1]).get("tab"), [tab,setTab]=useState(initial || "overview"), points=historyOf(m,pve,pc), s=stats(m), times=points.map(p=>p.t);
  useEffect(()=>setTab(initial || "overview"),[initial]);
  const api=useMemo(()=>pve.standalone ? pc.host : combinedEvents(pve.host,pc.host,!!m.pc),[pve.standalone,pve.host,pc.host,!!m.pc]), service=pve.standalone ? "pc" : "pve";
  const events=usePoll<{events:MonitoringEvent[]}>(api,tab==="events" ? `/api/${service}/events` : null,30);
  const ownEvents=(events.data?.events || []).filter(e=>pve.standalone ? e.host===m.pc?.id : e.host===`pve:${m.pve?.id}` || e.host===`pc:${m.pc?.id}`);
  const backups=(m.pve?.current?.backups || []).filter(b=>!m.guest || b.vmid===m.guest.vmid);
  const linkedApps=m.guest ? pve.appsOf(m.guest) : m.kind==="server" ? flatten(m.children).flatMap(c=>c.guest ? pve.appsOf(c.guest) : []) : containersOf(m.pc ? [m.pc] : []).filter(r=>!m.wsl||r.d.context===`wsl:${m.wsl.name}`).flatMap(({h,d,c})=>pc.appsOf(h,d.context,c)), apps=[...new Map(linkedApps.map(a=>[a.key,a])).values()], containers=machineContainers(m), physical=m.kind==="server"||m.kind==="pc";
  return <><nav className="mc-crumb"><a href={pve.standalone ? "#/pc" : "#/pveguests"} onClick={onBack}>Устройства</a>{m.parent&&<><Icon name="chevronRight" size={13}/><a href={`#/${machineRoute(m.parent)}`}>{m.parent.name}</a></>}<Icon name="chevronRight" size={13}/><b>{m.name}</b></nav>
    <header className="mc-machine-heading"><MachineName m={m} heading/><div className="mc-power">{m.pve ? <><ActionButtons h={m.pve} g={m.guest}/><a className="pve-btn ghost" href={proxmoxURL(m.pve,m.guest)} target="_blank" rel="noreferrer"><Icon name="terminal" size={15}/>Консоль Proxmox <Icon name="external" size={13}/></a></> : m.wsl&&m.pc ? <Controls target={{h:m.pc,w:m.wsl}}/> : <button className="pve-btn" disabled title="pc-agent не предоставляет управление питанием компьютера"><Icon name="lock" size={14}/>Питание недоступно</button>}</div></header>
    <div className="mc-tabs">{[["overview","Обзор"],["config","Конфигурация"],["backups","Копии"],["events","События"],...(physical ? [["hardware","Железо"]] : [])].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==="overview"&&<div className="mc-machine-layout"><div className="mc-machine-main">{m.wsl ? <p className="pv-warning">CPU, память, сеть и диски WSL входят в общую нагрузку {m.parent?.name}. Агент не передаёт отдельные метрики WSL.</p> : <div className="mc-charts"><Chart title={`CPU · сутки · ${percent(s.cpu)}`} times={times} values={points.map(p=>p.cpu)} format={percent}/><Chart title={`Память · сутки · ${bytes(s.mem)} / ${bytes(s.total)}`} times={times} values={points.map(p=>p.mem)} format={bytes}/><div className="pv-chart"><h4>Сеть · сутки</h4>{points.some(p=>p.rx!=null) ? <TimeChart times={times} series={[{label:"Приём",values:points.map(p=>p.rx),color:"var(--hp-blue)"},{label:"Передача",values:points.map(p=>p.tx),color:"var(--hp-acc)"}]} format={bits} height={90} axis label="Сеть за сутки"/> : <small>Агент не передаёт историю сети этой машины</small>}</div></div>}
      {(pve.historyErrors[m.pve?.id || ""] || pc.history.errors[m.pc?.id || ""])&&<p className="pv-warning">История не обновилась: {pve.historyErrors[m.pve?.id || ""] || pc.history.errors[m.pc?.id || ""]}</p>}
      <section className="pv-card"><h2>Внутри</h2><a className="mc-inside" href={containerLink(m)}><Icon name="dms" size={21}/><div><b>{m.pc || physical ? `${physical&&m.kind==="server" ? m.children.reduce((n,c)=>n+machineContainers(c).length,0) : containers.length} контейнеров` : "Контейнеры неизвестны"}</b><small>{m.pc ? "Состояние, порты и логи" : m.kind==="server" ? "Контейнеры вложенных машин" : "Для сведений нужен pc-agent"}</small></div><Icon name="chevronRight" size={16}/></a><a className="mc-inside" href="#apps"><Icon name="overview" size={21}/><div><b>{apps.length} приложений HomeNet</b><small>Открыть страницу приложений</small></div><Icon name="chevronRight" size={16}/></a>{m.children.length>0&&<a className="mc-inside" href={`#/${pve.standalone ? "pc" : "pveguests"}?filter=${m.kind==="server" ? "vm" : "wsl"}&parent=${encodeURIComponent(m.key)}`}><Icon name="servers" size={21}/><div><b>{m.children.length} {m.kind==="server" ? "VM" : "WSL"}</b><small>В списке устройств</small></div><Icon name="chevronRight" size={16}/></a>}</section></div>
      <aside className="pv-card"><h2>Кратко</h2><dl className="pv-kv"><dt>Процессор</dt><dd>{m.guest ? `${m.guest.cpus} vCPU · ${m.guest.config?.cpu || "—"}` : m.pve?.hardware?.cpu.model || m.pc?.current?.cpu.model || "—"}</dd><dt>Память</dt><dd>{m.wsl ? "В общей нагрузке ПК" : bytes(s.total)}</dd><dt>Диск</dt><dd>{s.diskTotal ? `${percent(ratio(s.diskUsed || 0,s.diskTotal))} из ${bytes(s.diskTotal)}` : "Нет данных"}</dd><dt>Работает</dt><dd>{uptime(s.uptime)}</dd><dt>Родитель</dt><dd>{m.parent?.name || "Физическое устройство"}</dd><dt>Агент</dt><dd>{m.pc ? `pc-agent ${m.pc.current?.agent || "—"}${m.pc.current?.capabilities.docker_logs ? " · логи" : ""}` : m.guest ? "Только данные Proxmox" : m.pve?.current?.versions.agent || "—"}</dd><dt>Копия</dt><dd>{backups.length ? ago([...backups].sort((a,b)=>b.start-a.start)[0].start) : "Нет данных"}</dd></dl>{m.pc&&!m.pc.online&&<p className="pv-warning">pc-agent не отвечает: {m.pc.error}</p>}</aside></div>}
    {tab==="config"&&<section className="pv-card"><h2>Конфигурация {m.name}</h2>{m.guest?.config ? <dl className="pv-kv"><dt>CPU</dt><dd>{m.guest.config.cpu} · {m.guest.config.cores || m.guest.cpus} ядер</dd><dt>Память</dt><dd>{m.guest.config.memory} МБ</dd><dt>Диски</dt><dd>{m.guest.config.disks.map(d=><p key={d.slot}>{d.slot}: {d.volume} · {d.size}</p>)}</dd><dt>Сеть</dt><dd>{m.guest.config.networks.map(n=><p key={n.slot}>{n.slot}: {n.bridge} · {pve.hide ? "MAC скрыт" : n.mac}</p>)}</dd></dl> : <dl className="pv-kv"><dt>Система</dt><dd>{m.pc?.current?.os || `Proxmox ${m.pve?.current?.versions.pve || ""}`}</dd><dt>Агент</dt><dd>{m.pc?.current?.agent || m.pve?.current?.versions.agent || "—"}</dd><dt>Обновления</dt><dd>{m.pve?.current?.updates ?? "Нет данных"}</dd><dt>Службы</dt><dd>{m.pve?.current?.failed_units.join(", ") || "Нет ошибок в снимке"}</dd></dl>}{m.pc?.current?.disks.length ? <details className="mc-more"><summary>Диски ({m.pc.current.disks.length})</summary>{m.pc.current.disks.map(d=><p key={d.path}>{d.path}: {bytes(d.used)} / {bytes(d.total)} · свободно {bytes(d.free)}</p>)}</details> : null}{m.wsl&&<p>WSL {m.wsl.version} · {m.wsl.state}</p>}</section>}
    {tab==="backups"&&<section className="pv-card">{m.pve ? <BackupList backups={backups}/> : <Empty title="Данных о копиях нет">pc-agent не передаёт сведения о резервных копиях компьютера или WSL.</Empty>}</section>}
    {tab==="events"&&<section className="pv-card">{events.error&&<p className="pv-warning">{events.error}</p>}{ownEvents.length ? ownEvents.map(e=><article key={e.id}><b>{e.title}</b><p>{e.message}</p><small>{new Date(e.created_at).toLocaleString("ru-RU")}</small></article>) : <Empty title="Событий пока нет"/>}</section>}
    {tab==="hardware"&&physical&&<section className="pv-card mc-single-board"><Board machine={m}/></section>}
  </>;
}
