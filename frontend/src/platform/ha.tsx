import { Empty } from "../features/pve/parts";
import { Overview } from "../features/ha/Overview";
import { Settings } from "../features/ha/Settings";
import { age, useHaOverview, type HaOverview } from "../features/ha/model";
import "../features/pve/pve.css";
import "../features/ha/ha.css";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";

// NPM-76: «Умный дом» — Home Assistant read over its REST API. Core's menu lists these
// pages; without Core's menu the module shows them as its own tabs.
const PAGES: { id: string; title: string }[] = [
  { id: "ha", title: "Обзор" },
  { id: "hasettings", title: "Настройка" },
];

function Tabs({ page, host }: { page: string; host: Host }) {
  if (host.shellNav) return null;
  return (
    <nav className="section-tabs module-tabs" aria-label="Страницы «Умный дом»">
      {PAGES.map((p) => (
        <a key={p.id} href={`#/${p.id}`} className="section-tab" aria-current={p.id === page ? "page" : undefined}
          onClick={(e) => { e.preventDefault(); host.navigate(p.id); }}>{p.title}</a>
      ))}
    </nav>
  );
}

function HealthLine({ data }: { data: HaOverview }) {
  const bad = !!data.error;
  return (
    <div className={`pve-health${bad ? " bad" : ""}`} role="status">
      <span className="pve-health-dot" aria-hidden="true" />
      <span>
        {bad
          ? `Нет связи с Home Assistant: ${data.error}${data.last_ok ? `. Показаны данные ${age(data.last_ok)} назад.` : "."}`
          : `Home Assistant ${data.version}${data.location ? ` · ${data.location}` : ""} на связи.`}
      </span>
      <span className="pve-muted">Обновлено {data.checked_at ? `${age(data.checked_at)} назад` : "—"} · опрос раз в минуту</span>
      {data.link ? <a className="pve-btn ha-health-link" href={data.link} target="_blank" rel="noopener noreferrer">Открыть Home Assistant</a> : null}
    </div>
  );
}

function HaModule({ host }: { host: Host }) {
  const page = usePage();
  const { data, error, loading, reload } = useHaOverview(host);
  const current = PAGES.some((p) => p.id === page) ? page : "ha";
  let body;
  if (current === "hasettings") body = <Settings host={host} onSaved={() => window.setTimeout(() => void reload(), 3000)} />;
  else if (loading && !data) body = <div className="pve-page"><div className="pve-skeleton" /><div className="pve-skeleton tall" /></div>;
  else if (!data) body = <Empty title="Интеграция не отвечает">{error}</Empty>;
  else if (!data.configured) body = <Empty title="Home Assistant не подключён">{data.load_error || "Укажите адрес и токен на странице «Настройка»."}</Empty>;
  else body = <Overview data={data} host={host} />;
  return (
    <div className="pve-module">
      <Tabs page={current} host={host} />
      {data?.configured && current !== "hasettings" ? <HealthLine data={data} /> : null}
      {error && data ? <div className="pve-health bad" role="alert"><span className="pve-health-dot" aria-hidden="true" />Не удалось обновить: {error}. Показаны последние данные.</div> : null}
      {body}
    </div>
  );
}

export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><HaModule host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
