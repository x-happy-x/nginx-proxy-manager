import { useCallback, useEffect, useState } from "react";
import { Deployments } from "../pages/Deployments";
import type { DmsApp } from "../types";
import { request } from "./sdk";

export function System() {
 const [items,setItems]=useState<DmsApp[]>([]);
 const [version,setVersion]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [proxy,setProxy]=useState(false);
 const [notice,setNotice]=useState("");
 useEffect(()=>{void request("/api/platform").then(r=>r.json()).then(data=>setProxy(data.integrations.some((i:{enabled:boolean;manifest:{id:string}})=>i.enabled&&i.manifest.id==="proxy"))).catch(()=>{});},[]);
 const importRoutes=async(item:DmsApp)=>{setBusy(true);setError("");try{await request("/api/routes/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(item.pending_routes)});setNotice("Домены перенесены в черновик Прокси. Откройте Прокси, проверьте изменения и примените конфигурацию.");}catch(e){setError(String(e));}finally{setBusy(false);}};
 const refresh=useCallback(async()=>{setBusy(true);setError("");try{const data=await(await request("/api/dms/apps")).json();setItems((data.items||[]).filter((item:DmsApp)=>!item.app.startsWith("homenet-")));setVersion(data.service_version||"");}catch(e){setError(String(e));}finally{setBusy(false);}},[]);
 useEffect(()=>{void refresh();},[refresh]);
 return <><h1>Система</h1><section className="hn-card"><h2>HomeNet Core</h2><p>Общая панель, приложения и доступы. Авторизация через Account.</p><p>Настройки и резервные копии платформы хранятся отдельно от интеграций. Адрес консоли задаётся в конфигурации Core.</p></section>{error&&<p className="hn-warning" role="alert">{error}</p>}{notice&&<p role="status">{notice} <a href="#/servers">Открыть Прокси</a></p>}
 {items.filter(i=>i.pending_routes).map(i=><section className="hn-card" key={i.app}><h3>Публикация доменов: {i.name||i.app}</h3><p>Приложение установлено. Домены из пакета публикуются отдельно через Прокси.</p><p>{i.pending_routes?.hosts?.map(h=>h.host).join(", ")}</p><button disabled={busy||!proxy} onClick={()=>void importRoutes(i)}>Перенести в черновик Прокси</button>{!proxy&&<p>Установите и включите интеграцию «Прокси и домены».</p>}</section>)}
 <div className="hn-dms"><Deployments busy={busy} items={items} serviceVersion={version} onRefresh={()=>void refresh()}/></div></>;
}
