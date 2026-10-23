import { useEffect, useMemo, useState } from "react";
import { ModuleBoundary } from "./module-base";
import { request, type Host } from "./sdk";
import { Icon } from "../components/ui/Icon";
import { PveProvider, usePve } from "../features/pve/context";
import { PcProvider } from "../features/pc/context";
import { useComputers } from "../features/pc/model";
import { Management } from "../features/pve/Actions";
import { Management as PcManagement } from "../features/pc/Actions";
import { Details as PcDetails } from "../features/pc/Details";
import { Settings } from "../features/pve/Settings";
import { Settings as PcSettings } from "../features/pc/Settings";
import { Storage } from "../features/pve/Storage";
import { Resources } from "../features/pve/Views";
import { Empty } from "../features/pve/parts";
import { useOverview } from "../features/pve/model";
import { Containers, Devices, Events, Hardware, MachinePage, Overview, useMachineTree } from "../features/machines/Views";
import { flatten, machineRoute } from "../features/machines/model";
import "../styles/portal-home.css";
import "../features/pve/pve.css";
import "../features/pve/redesign.css";
import "../features/pc/pc.css";
import "../features/machines/machines.css";

const menu = [["pve","Обзор"],["pveguests","Устройства"],["pve/containers","Контейнеры"],["pve/resources","Ресурсы"],["pvehw","Железо"],["pvestorage","Хранилища и копии"],["pve/events","События"],["pvesettings","Настройка"]];
function Dashboard({ reload, pcReload, configured, pcHost, pcEnabled, pcLoading, pcError }: { reload:()=>Promise<void>; pcReload:()=>Promise<void>; configured:boolean; pcHost:Host; pcEnabled:boolean; pcLoading:boolean; pcError:string }) {
  const ctx=usePve(), roots=useMachineTree(), [route,setRoute]=useState(location.hash.replace(/^#\/?/,"")), [refreshing,setRefreshing]=useState(false);
  useEffect(()=>{const update=()=>setRoute(location.hash.replace(/^#\/?/,""));window.addEventListener("hashchange",update);return()=>window.removeEventListener("hashchange",update);},[]);
  const path=route.split("?")[0], all=flatten(roots), selected=ctx.target, pcAlias=path.match(/^pveguests\/pc\/([^/]+)$/), target=all.find(m=>machineRoute(m)===path || m.kind==="server"&&path===`pve/${encodeURIComponent(m.pve!.id)}/node/0` || pcAlias&&m.pc?.id===decodeURIComponent(pcAlias[1])&&!m.wsl) || (selected ? all.find(m=>m.pve?.id===selected.host&&(selected.vmid ? m.guest?.vmid===selected.vmid&&m.guest.type===selected.type : m.kind==="server")) : undefined);
  const section=path.startsWith("pveguests") ? "devices" : path==="pve/containers" ? "containers" : path==="pve/resources" ? "resources" : path==="pvehw" ? "hardware" : path==="pvestorage" ? "storage" : path==="pvesettings" ? "settings" : path==="pve/events" ? "events" : "overview";
  const title={overview:"Машины",devices:"Устройства",containers:"Контейнеры",resources:"Ресурсы",hardware:"Железо",storage:"Хранилища и копии",settings:"Настройка",events:"События"}[section];
  const refresh=async()=>{setRefreshing(true);try{await Promise.all([reload(),pcReload()]);}finally{setRefreshing(false);}};
  const unknownDetail=!target&&(path.startsWith("pveguests/")||/^pve\/[^/]+\/node\//.test(path));
  return <>{!ctx.host.shellNav&&<nav className="pv-nav" aria-label="Разделы машин">{menu.map(([id,label])=><a key={id} href={`#/${id}`}>{label}</a>)}</nav>}
    {!target&&<header className="pv-heading"><div><h1>{title}</h1><p>{roots.length} физических устройств · {all.filter(m=>m.kind==="vm").length} VM · {all.filter(m=>m.kind==="wsl").length} WSL</p></div><div className="pv-heading-tools">{section!=="settings"&&<><label className="mc-search"><Icon name="search" size={16}/><input type="search" aria-label="Поиск машины или контейнера" placeholder="Машина, контейнер, IP или порт" value={ctx.query} onChange={e=>ctx.setQuery(e.target.value)}/></label><button className="pve-btn ghost" title={ctx.hide ? "Показать адреса" : "Скрыть адреса"} aria-label={ctx.hide ? "Показать адреса" : "Скрыть адреса"} aria-pressed={ctx.hide} onClick={()=>ctx.setHide(!ctx.hide)}><Icon name={ctx.hide ? "eyeOff" : "eye"} size={17}/></button></>}<button className="pve-btn ghost" disabled={refreshing} onClick={()=>void refresh()}><Icon name="refresh" size={15}/>{refreshing ? "Обновляю…" : "Обновить"}</button></div></header>}
    {!pcEnabled&&<p className="mc-source-note" role="status">{pcLoading ? "Подключаем данные компьютеров…" : "Доступны данные Proxmox. Модуль компьютеров выключен, не установлен или не отвечает; ПК, WSL и контейнеры недоступны."}{pcError&&<details><summary>Причина</summary>{pcError}</details>}</p>}
    <Management host={ctx.host} hosts={ctx.hosts} enabled={configured} onRefresh={reload}><PcManagement host={pcHost} computers={all.flatMap(m=>m.pc&&!m.wsl ? [m.pc] : [])} enabled={pcEnabled} reload={pcReload}>
      {target ? <MachinePage key={target.key} m={target} onBack={()=>ctx.setTarget(null)}/> : unknownDetail ? <Empty title="Машина не найдена">Обновите данные или <a href="#/pveguests">откройте устройства</a>.</Empty> : section==="settings" ? <div className="mc-settings"><section><Settings host={ctx.host} onSaved={reload}/></section><section><h2>Компьютеры</h2>{pcEnabled ? <PcSettings host={pcHost} onSaved={pcReload}/> : <Empty title="Модуль компьютеров недоступен">Включите или установите интеграцию «Компьютеры» в Core.</Empty>}</section></div> : section==="overview" ? <Overview roots={roots}/> : section==="devices" ? <Devices roots={roots} route={route}/> : section==="containers" ? <Containers roots={roots} route={route}/> : section==="resources" ? <Resources hosts={ctx.hosts.filter(h=>ctx.matches(h))}/> : section==="hardware" ? <Hardware roots={roots}/> : section==="storage" ? <Storage hosts={ctx.hosts.filter(h=>ctx.matches(h))}/> : <Events pcEnabled={pcEnabled}/>}
      <PcDetails/>
    </PcManagement></Management></>;
}
function PveModule({ host }: { host: Host }) {
  const {data,error,loading,reload}=useOverview(host);
  const pcHost=useMemo<Host>(()=>({...host,api:(path,init)=>request(`/api/integrations/pc${path}`,init)}),[host]);
  const pc=useComputers(pcHost);
  return <div className="hp pv-root mc-root"><div className="pve-module">{pc.error&&pc.data&&<p className="pv-warning">Данные компьютеров не обновились: {pc.error}. Показан последний снимок.</p>}{error&&<div className="pv-warning" role="alert">Не удалось обновить данные: {error}</div>}{loading&&!data ? <div className="pve-skeleton"/> : !data ? <Empty title="Интеграция не отвечает">{error}</Empty> : <PveProvider host={host} hosts={data.hosts || []}><PcProvider host={pcHost} computers={pc.data?.hosts || []}><Dashboard reload={reload} pcReload={pc.reload} configured={data.configured} pcHost={pcHost} pcEnabled={!!pc.data} pcLoading={pc.loading} pcError={pc.error}/></PcProvider></PveProvider>}</div></div>;
}
export function mount(element: HTMLElement, host: Host) { if(host.protocol!==1) throw new Error("Несовместимая версия HomeNet"); const root=host.createRoot(element);root.render(<ModuleBoundary><PveModule host={host}/></ModuleBoundary>);return()=>root.unmount(); }
