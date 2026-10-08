import { useEffect, useState } from "react";
import { request, type Installed, type Manifest } from "./sdk";

type Operation = { id: string; status: string; step?: string; error?: string; changes?: {id:string;action:string;version?:string}[] };
const statusText: Record<string,string> = {planned:"План готов",running:"Выполняется",succeeded:"Завершено",failed:"Ошибка",rejected:"План отклонён",rolled_back:"Восстановлена предыдущая версия",recovery_required:"Требуется восстановление",interrupted:"Прервано",recovering:"Восстановление"};
const actionText: Record<string,string> = {install:"Установить",update:"Обновить",rollback:"Откатить",enable:"Включить",disable:"Отключить",remove:"Удалить интеграцию"};
const post = async <T,>(url:string,body:unknown):Promise<T> => (await request(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json();
export function IntegrationDetails({id,installed,dmsAvailable,onRefresh}:{id:string;installed?:Installed;dmsAvailable:boolean;onRefresh:()=>void}) {
  const [packages,setPackages]=useState<Manifest[]>([]);
  const [version,setVersion]=useState("");
  const [managed,setManaged]=useState(false);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [plan,setPlan]=useState<Operation>();
  const [job,setJob]=useState<Operation>();
  const [jobPath,setJobPath]=useState(()=>sessionStorage.getItem(`homenet-operation-${id}`)||"");
  const [file,setFile]=useState<File>();
  const [uploadPlan,setUploadPlan]=useState<string>();
  const [uploadKey,setUploadKey]=useState(()=>crypto.randomUUID());
  const refresh=async()=>{const body=await(await request("/api/platform/packages")).json();const items=(body.items as Manifest[]).filter(p=>p.id===id).sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true}));setPackages(items);setManaged(body.managed);setVersion(v=>v||items[items.length-1]?.version||"");};
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));},[id]);
  useEffect(()=>{
    if(!jobPath)return;
    sessionStorage.setItem(`homenet-operation-${id}`,jobPath);
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const op=await(await request(jobPath)).json() as Operation;if(!alive)return;setJob(op);if(["planned","running","recovering"].includes(op.status)){timer=setTimeout(poll,1000);}else{setBusy(false);sessionStorage.removeItem(`homenet-operation-${id}`);onRefresh();await refresh();}}catch(e){if(alive){setError(String(e));setBusy(false);}}};
    void poll();return()=>{alive=false;clearTimeout(timer);};
  },[jobPath,id]);
  const prepare=async(action:string)=>{setBusy(true);setError("");setJob(undefined);try{setPlan(await post<Operation>("/api/platform/plan",{changes:[{id,action,version}]}));}catch(e){setError(String(e));}finally{setBusy(false);}};
  const apply=async()=>{if(!plan)return;setBusy(true);setError("");try{await post("/api/platform/apply",{id:plan.id});setJobPath(`/api/platform/operations/${plan.id}`);setPlan(undefined);}catch(e){setBusy(false);setError(String(e));}};
  const upload=async(dry:boolean)=>{if(!file)return;setBusy(true);setError("");try{const body=await(await request(`/api/dms/packages${dry?"?dry_run=true":""}`,{method:"POST",headers:{"Content-Type":"application/gzip","Idempotency-Key":uploadKey},body:file})).json();if(dry){if(body.plan?.integration?.id!==id||!body.plan?.integration?.staged)throw new Error("Архив не является пакетом выбранной интеграции");setUploadPlan(body.plan.metadata.version);}else{setUploadPlan(undefined);setJobPath(`/api/dms/jobs/${body.id}`);}}catch(e){setError(String(e));setBusy(false);}finally{if(dry)setBusy(false);}};
  const selected=packages.find(p=>p.version===version);
  return <div className="hn-details">
    {error&&<p className="hn-error" role="alert">{error}</p>}
    {job&&<div className="hn-notice" role="status"><div><b>{statusText[job.status]||job.status}</b><p>{job.step}</p><small>{job.id}</small>{job.error&&<p>{job.error}</p>}</div></div>}
    <h3>{installed?`Установлена версия ${installed.manifest.version}`:"Установка интеграции"}</h3>
    <p>Настройки, история и внешние службы сохраняются при отключении и удалении интеграции управления.</p>
    <label>Подготовленная версия <select value={version} onChange={e=>{setVersion(e.target.value);setPlan(undefined);}}><option value="">Выберите версию</option>{packages.map(p=><option key={p.version}>{p.version}</option>)}</select></label>
    {!packages.length&&<p>Пакет ещё не загружен. Подготовьте архив через DMS ниже.</p>}
    {!managed&&<p className="hn-warning">Управление процессами отключено в этом проверочном окружении.</p>}
    <div className="hn-actions" style={{marginTop:16}}>
      {!installed?<button className="hn-primary" disabled={busy||!selected||!managed} onClick={()=>void prepare("install")}>Установить</button>:<>
        <button disabled={busy||!managed} onClick={()=>void prepare(installed.enabled?"disable":"enable")}>{installed.enabled?"Отключить":"Включить"}</button>
        <button disabled={busy||!managed||!selected||version===installed.manifest.version} onClick={()=>void prepare("update")}>Сменить версию</button>
        <button disabled={busy||!managed} onClick={()=>void prepare("remove")}>Удалить интеграцию</button>
      </>}
    </div>
    {plan&&<section className="hn-card" style={{marginTop:18}}><h3>План изменений</h3>{plan.changes?.map(c=><p key={c.id}>{actionText[c.action]||c.action}: {c.id} {c.version}</p>)}<p>Будут переключены только управляющие процессы. При ошибке проверки восстановится предыдущий набор версий. nginx и mihomo не останавливаются.</p><button className="hn-primary" disabled={busy} onClick={()=>void apply()}>Выполнить план</button><button disabled={busy} onClick={()=>setPlan(undefined)}>Отмена</button></section>}
    <hr/><h3>Загрузить пакет через DMS</h3><p>Архив сначала проходит проверку. Загрузка подготавливает версию без её запуска.</p>
    <input aria-label="Архив интеграции" type="file" accept=".gz,.tgz" disabled={busy||!dmsAvailable} onChange={e=>{setFile(e.target.files?.[0]);setUploadPlan(undefined);setUploadKey(crypto.randomUUID());}}/>
    <div className="hn-actions" style={{marginTop:12}}><button disabled={busy||!file||!dmsAvailable} onClick={()=>void upload(true)}>Проверить архив</button>{uploadPlan&&<button className="hn-primary" disabled={busy||!dmsAvailable} onClick={()=>void upload(false)}>Подготовить версию {uploadPlan}</button>}</div>
    {!dmsAvailable&&<p>Для загрузки архива нужно восстановить соединение с DMS. Подготовленные версии доступны выше.</p>}
  </div>;
}
