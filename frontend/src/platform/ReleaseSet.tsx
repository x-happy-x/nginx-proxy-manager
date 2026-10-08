import { useEffect, useState } from "react";
import { request, type Installed, type Manifest } from "./sdk";
type Change={id:string;action:string;version:string};
type Operation={id:string;status:string;error?:string;changes:Change[]};
const post=async(url:string,body:unknown)=>(await(await request(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json()) as Operation;

export function ReleaseSet({installed,onRefresh}:{installed:Installed[];onRefresh:()=>void}){
 const [packages,setPackages]=useState<Manifest[]>([]),[managed,setManaged]=useState(false),[changes,setChanges]=useState<Record<string,Change>>({});
 const [operation,setOperation]=useState<Operation>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [active,setActive]=useState(()=>sessionStorage.getItem("homenet-release-set")||"");
 useEffect(()=>{void request("/api/platform/packages").then(r=>r.json()).then(b=>{setPackages(b.items);setManaged(b.managed);}).catch(e=>setError(String(e)));},[]);
 useEffect(()=>{
  if(!active)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;
  sessionStorage.setItem("homenet-release-set",active);
  const poll=async()=>{try{const op=await(await request(`/api/platform/operations/${active}`)).json() as Operation;if(disposed)return;setOperation(op);if(["planned","running","recovering"].includes(op.status)){timer=setTimeout(poll,1000);}else{setBusy(false);sessionStorage.removeItem("homenet-release-set");onRefresh();}}catch(e){if(!disposed){setBusy(false);setError(String(e));}}};
  void poll();return()=>{disposed=true;clearTimeout(timer);};
 },[active]);
 const ids=[...new Set([...packages.map(p=>p.id),...installed.map(i=>i.manifest.id)])];
 const update=(id:string,patch:Partial<Change>)=>{setChanges(old=>({...old,[id]:{...(old[id]||{id,action:"keep",version:""}),...patch}}));setOperation(undefined);};
 const prepare=async()=>{setBusy(true);setError("");try{setOperation(await post("/api/platform/plan",{changes:Object.values(changes).filter(c=>c.action!=="keep")}));}catch(e){setError(String(e));}finally{setBusy(false);}};
 const apply=async()=>{if(!operation)return;setBusy(true);setError("");try{await post("/api/platform/apply",{id:operation.id});setActive(operation.id);}catch(e){setError(String(e));setBusy(false);}};
 return <section className="hn-card"><h2>Набор версий</h2><p>Выберите изменения для нескольких интеграций. HomeNet проверит совместимость всего набора и восстановит прежние версии, если запуск не пройдёт проверку.</p>
 {error&&<p role="alert" className="hn-error">{error}</p>}
 {ids.map(id=>{const current=installed.find(i=>i.manifest.id===id);const versions=packages.filter(p=>p.id===id).sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true}));return <div key={id} className="hn-set-row"><b>{current?.manifest.name||versions[0]?.name||id}</b><small>{current?.manifest.version||"Не установлено"}</small><select aria-label={`Действие ${id}`} disabled={busy} value={changes[id]?.action||"keep"} onChange={e=>update(id,{action:e.target.value})}><option value="keep">Без изменений</option>{current?<><option value="update">Сменить версию</option><option value={current.enabled?"disable":"enable"}>{current.enabled?"Отключить":"Включить"}</option><option value="remove">Удалить</option></>:<option value="install">Установить</option>}</select><select aria-label={`Версия ${id}`} disabled={busy||!["install","update"].includes(changes[id]?.action)} value={changes[id]?.version||""} onChange={e=>update(id,{version:e.target.value})}><option value="">Версия</option>{versions.map(p=><option key={p.version}>{p.version}</option>)}</select></div>})}
 {!ids.length&&<p>Сначала загрузите пакеты из карточек каталога.</p>}
 <button disabled={busy||!managed||!Object.values(changes).some(c=>c.action!=="keep")} onClick={()=>void prepare()}>Проверить набор</button>
 {operation&&<div className="hn-notice"><div><b>{operation.status==="planned"?"План готов":operation.status==="succeeded"?"Набор применён":operation.status==="rolled_back"?"Прежний набор восстановлен":operation.status}</b>{operation.changes.map(c=><p key={c.id}>{c.id}: {c.action} {c.version}</p>)}{operation.error&&<p role="alert">{operation.error}</p>}{operation.status==="planned"&&<button className="hn-primary" disabled={busy} onClick={()=>void apply()}>Применить набор</button>}</div></div>}
 </section>;
}
