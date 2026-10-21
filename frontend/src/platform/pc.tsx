import { useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Management } from "../features/pc/Actions";
import { Overview } from "../features/pc/Overview";
import { Settings } from "../features/pc/Settings";
import { Docker, Wsl } from "../features/pc/Workloads";
import { outdated, useComputers } from "../features/pc/model";
import { ago } from "../features/pve/model";
import { Empty } from "../features/pve/parts";
import "../features/pve/pve.css";
import "../features/pc/pc.css";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";

const pages = [{ id: "pc", title: "Обзор" }, { id: "pcdocker", title: "Docker" }, { id: "pcwsl", title: "WSL" }, { id: "pcsettings", title: "Настройка" }];

function Computers({ host }: { host: Host }) {
  const route = usePage();
  const page = pages.some((p) => p.id === route) ? route : "pc";
  const { data, loading, error, reload } = useComputers(host);
  const [refreshing, setRefreshing] = useState(false);
  const computers = data?.hosts || [];
  const unavailable = computers.filter(outdated);
  const latest = computers.map((h) => h.checked_at || "").sort().slice(-1)[0];
  let content;
  if (page === "pcsettings") content = <Settings host={host} onSaved={reload} />;
  else if (loading && !data) content = <div className="pve-skeleton tall" />;
  else if (!data) content = <Empty title="Интеграция не отвечает">{error || "Попробуйте обновить страницу."}</Empty>;
  else if (!data.configured) content = <div className="pc-welcome card"><span className="pc-system-icon"><Icon name="system" size={28} /></span><h2>Подключите домашние компьютеры</h2><p>Наблюдайте за ресурсами Windows и Linux, управляйте контейнерами Docker и дистрибутивами WSL.</p><button type="button" className="pve-btn primary" onClick={() => host.navigate("pcsettings")}>Подключить компьютер</button></div>;
  else if (page === "pcdocker") content = <Docker computers={computers} />;
  else if (page === "pcwsl") content = <Wsl computers={computers} />;
  else content = <Overview host={host} computers={computers} />;
  return <div className="pve-module pc-module">
    {!host.shellNav ? <nav className="section-tabs module-tabs" aria-label="Компьютеры">{pages.map((p) => <a className="section-tab" key={p.id} href={`#/${p.id}`} aria-current={p.id === page ? "page" : undefined} onClick={(e) => { e.preventDefault(); host.navigate(p.id); }}>{p.title}</a>)}</nav> : null}
    {data?.configured && page !== "pcsettings" ? <div className={`pve-health${unavailable.length ? " bad" : ""}`} role="status"><span className="pve-health-dot" /><span>{unavailable.length ? `Нет свежих данных: ${unavailable.map((h) => h.name).join(", ")}` : `На связи: ${computers.map((h) => h.name).join(", ")}`}</span><span className="pve-muted">Обновлено {ago(latest)}</span><button type="button" className="pve-btn ghost" disabled={refreshing} onClick={() => { setRefreshing(true); void reload().finally(() => setRefreshing(false)); }}><Icon name="refresh" size={14} />{refreshing ? "Обновляю…" : "Обновить"}</button></div> : null}
    {error && data ? <div className="pc-error" role="alert">Не удалось обновить данные: {error}. Показан последний полученный снимок.</div> : null}
    <Management host={host} computers={computers} enabled={!!data?.configured} reload={reload}>{content}</Management>
  </div>;
}

export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><Computers host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
