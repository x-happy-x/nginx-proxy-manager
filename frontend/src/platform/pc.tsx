import { useState } from "react";
import { Management } from "../features/pc/Actions";
import { EventCenter } from "../features/monitoring/EventCenter";
import { Overview } from "../features/pc/Overview";
import { Settings } from "../features/pc/Settings";
import { Docker, Wsl } from "../features/pc/Workloads";
import { Details } from "../features/pc/Details";
import { PcProvider } from "../features/pc/context";
import { PcHeading } from "../features/pc/parts";
import { useComputers } from "../features/pc/model";
import { Empty } from "../features/pve/parts";
import "../features/pve/pve.css";
import "../styles/portal-home.css";
import "../features/pc/pc.css";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";

const pages = [{ id: "pc", title: "Компьютеры" }, { id: "pcdocker", title: "Контейнеры" }, { id: "pcwsl", title: "WSL" }, { id: "pcsettings", title: "Настройка" }];
function Computers({ host }: { host: Host }) {
  const route = usePage(), page = pages.some(p => p.id === route) ? route : "pc";
  const { data, loading, error, reload } = useComputers(host);
  const [refreshing, setRefreshing] = useState(false);
  const computers = data?.hosts || [];
  const refresh = () => { setRefreshing(true); void reload().finally(() => setRefreshing(false)); };
  let content;
  if (page === "pcsettings") content = <div className="pc-page"><PcHeading privacy={false} title="Настройка" subtitle="Подключение компьютеров и разрешения агента" /><Settings host={host} onSaved={reload} /></div>;
  else if (loading && !data) content = <div className="pve-skeleton tall" aria-label="Загрузка компьютеров" />;
  else if (!data) content = <Empty title="Интеграция не отвечает">{error || "Попробуйте обновить страницу."}<button type="button" className="hp-btn" onClick={refresh}>Повторить</button></Empty>;
  else if (!data.configured) content = <div className="pc-welcome card"><h2>Подключите домашние компьютеры</h2><p>Windows и Linux, ресурсы, Docker и окружения WSL.</p><button type="button" className="hp-btn is-primary" onClick={() => host.navigate("pcsettings")}>Подключить компьютер</button></div>;
  else if (page === "pcdocker") content = <Docker />;
  else if (page === "pcwsl") content = <Wsl />;
  else content = <Overview reload={refresh} refreshing={refreshing} />;
  return <PcProvider host={host} computers={computers}><div className="hp pve-module pc-module">
    {!host.shellNav ? <nav className="section-tabs module-tabs" aria-label="Компьютеры">{pages.map(p => <a className="section-tab" key={p.id} href={`#/${p.id}`} aria-current={p.id === page ? "page" : undefined}>{p.title}</a>)}</nav> : null}
    {error && data ? <div className="pc-error" role="alert">Не удалось обновить данные: {error}. Показан последний снимок.</div> : null}
    <Management host={host} computers={computers} enabled={!!data?.configured} reload={reload}>{content}<Details /></Management>
    <EventCenter host={host} service="pc" hosts={computers} enabled={!!data?.configured} />
  </div></PcProvider>;
}
export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><Computers host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
