import { useEffect, useMemo, useState } from "react";
import App from "./App";
import { buildItems, defaultLauncher } from "./features/launcher/model";
import { ServiceIcon, artFor } from "./features/launcher/art";
import type { LauncherConfig } from "./api";
import type { RoutesDocument } from "./types";
import "./styles/portal.css";

type Rule = {mode:"admin"|"users"|"public";users:string[];ip_url?:string;domain_url?:string};
type Policy = {apps:Record<string,Rule>};
type Data = {login:string;admin:boolean;doc:RoutesDocument;launcher:LauncherConfig|null;links:Record<string,Rule>};
async function get<T,>(path:string):Promise<T> {
 const r=await fetch(path);if(!r.ok) throw new Error(`Не удалось загрузить данные (${r.status})`);return r.json();
}
export default function Portal() {
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState("");
 const [manage,setManage]=useState(false),[sharing,setSharing]=useState(false);
 const [policy,setPolicy]=useState<Policy>({apps:{}}),[users,setUsers]=useState<{login:string;name:string}[]>([]);
 const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[query,setQuery]=useState("");
 const load=()=>get<Data>("/api/portal").then(setData).catch(e=>setError(String(e)));
 useEffect(()=>{void load()},[]);
 const cfg=data?.launcher||defaultLauncher();
 const items=useMemo(()=>data?buildItems(data.doc,cfg,data.links):[],[data]);
 async function editAccess(){
  setError("");setSaved(false);
  try { const [p,u]=await Promise.all([get<Policy>("/api/access"),get<{users:{login:string;name:string}[]}>("/api/access/users")]);setPolicy(p);setUsers(u.users);setSharing(true) }catch(e){setError(String(e))}
 }
 function update(id:string,change:Partial<Rule>){setSaved(false);setPolicy(p=>({apps:{...p.apps,[id]:{...(p.apps[id]||{mode:"admin",users:[]}),...change}}}))}
 async function save(){
  setBusy(true);setError("");
  try {const r=await fetch("/api/access",{method:"POST",headers:{"Content-Type":"application/json","X-HomeNet-UI":"1"},body:JSON.stringify(policy)});if(!r.ok)throw new Error(await r.text());await load();setSaved(true)}catch(e){setError(String(e))}finally{setBusy(false)}
 }
 if(manage && data?.admin)return <><button className="portal-back" onClick={()=>setManage(false)}>← Приложения и доступы</button><App/></>;
 return <main className="portal">
  <header className="portal-head"><div><p className="portal-eyebrow">ДОМАШНЯЯ СЕТЬ</p><h1>HomeNet</h1><p>{data?.login?`Вы вошли как ${data.login}`:"Приложения с открытым доступом"}</p></div><nav>
   {data?.admin&&<><button onClick={()=>setManage(true)}>Управление роутером</button><button onClick={editAccess}>Доступы</button></>}
   <a className="portal-button" href="/_gate/login">{data?.login?"Сменить аккаунт":"Войти через Account"}</a>
  </nav></header>
  {error&&<p role="alert" className="portal-error">{error}</p>}
  {!data&&!error&&<p>Загрузка приложений…</p>}
  {sharing&&<section className="portal-sharing"><header><div><h2>Доступ к приложениям</h2><p>Администраторы HomeNet имеют доступ ко всем приложениям. Собственные логины приложений сохраняются.</p></div><button onClick={()=>setSharing(false)}>Закрыть</button></header>
   <p>Правила защищают вход через шлюз роутера. Прямые адреса сторонних серверов используют их собственную авторизацию.</p>
   {items.filter(i=>i.key!=="app:account"&&i.key!=="app:homenet").map(item=>{
    const id=item.key.startsWith("app:")?item.key.slice(4):item.key;
    const rule=policy.apps[id]||{mode:"admin",users:[]};
    return <article key={id} className="portal-rule"><h3>{item.title}</h3>
     <label>Кто может открыть<select value={rule.mode} onChange={e=>update(id,{mode:e.target.value as Rule["mode"]})}><option value="admin">Только администраторы</option><option value="users">Выбранные пользователи</option><option value="public">Все, без авторизации</option></select></label>
     {rule.mode==="users"&&<fieldset><legend>Пользователи Account</legend>{users.map(u=><label key={u.login} className="portal-user"><input type="checkbox" checked={rule.users.includes(u.login)} onChange={e=>update(id,{users:e.target.checked?[...rule.users,u.login]:rule.users.filter(x=>x!==u.login)})}/>{u.name} · {u.login}</label>)}</fieldset>}
     {rule.mode==="public"&&<p>Ссылка будет доступна без Account, в том числе через публичный домен.</p>}
     <div className="portal-addresses"><label>Ссылка при входе по IP<input value={rule.ip_url||""} placeholder={item.direct||"http://192.168.…"} onChange={e=>update(id,{ip_url:e.target.value})}/></label><label>Ссылка при входе по домену<input value={rule.domain_url||""} placeholder={item.public||"https://…"} onChange={e=>update(id,{domain_url:e.target.value})}/></label></div>
    </article>
   })}<footer><button disabled={busy} onClick={save}>{busy?"Сохраняю…":"Сохранить доступы"}</button>{saved&&<span role="status">Сохранено. Правила уже действуют.</span>}</footer>
  </section>}
  <input className="portal-search" aria-label="Поиск приложений" placeholder="Найти приложение…" value={query} onChange={e=>setQuery(e.target.value)}/>
  {[...cfg.devices,{id:"other",name:"Другие устройства",note:""}].map(device=>{
   const group=items.filter(i=>i.device===device.id&&!i.hidden&&i.key!=="app:homenet"&&(i.title+" "+i.description).toLowerCase().includes(query.toLowerCase()));
   return group.length>0&&<section key={device.id}><h2>{device.name}</h2><p>{device.note}</p><div className="portal-grid">{group.map(i=><a key={i.key} className="portal-card" href={i.primary}><span className="portal-icon"><ServiceIcon spec={artFor(i.art,i.title,...i.hints)}/></span><strong>{i.title}</strong><small>{new URL(i.primary,location.origin).host}</small><span aria-hidden="true">↗</span></a>)}</div></section>
  })}
  {data&&items.filter(i=>i.key!=="app:account"&&i.key!=="app:homenet").length===0&&<p>Пока нет доступных приложений. Войдите в Account или попросите администратора HomeNet предоставить доступ.</p>}
 </main>;
}
