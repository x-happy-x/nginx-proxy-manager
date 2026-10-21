import { useEffect, useState } from "react";
import { Guests } from "../features/pve/Guests";
import { Hardware } from "../features/pve/Hardware";
import { ago, useOverview, type PveHost } from "../features/pve/model";
import { Overview } from "../features/pve/Overview";
import { Empty } from "../features/pve/parts";
import { Settings } from "../features/pve/Settings";
import { Storage } from "../features/pve/Storage";
import { Management } from "../features/pve/Actions";
import { Icon } from "../components/ui/Icon";
import { stale } from "../features/pve/model";
import "../features/pve/pve.css";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";

// NPM-74/NPM-75: «Сервера» — Proxmox hosts over SSH. Core's menu lists these sections; when the
// module runs without Core's menu it shows the same list as its own tabs.
const PAGES: { id: string; title: string }[] = [
  { id: "pve", title: "Обзор" },
  { id: "pveguests", title: "Машины" },
  { id: "pvehw", title: "Железо и температуры" },
  { id: "pvestorage", title: "Хранилища" },
  { id: "pvesettings", title: "Настройка" },
];

function Tabs({ page, host }: { page: string; host: Host }) {
  if (host.shellNav) return null;
  return (
    <nav className="section-tabs module-tabs" aria-label="Страницы Proxmox">
      {PAGES.map((p) => (
        <a key={p.id} href={`#/${p.id}`} className="section-tab" aria-current={p.id === page ? "page" : undefined}
          onClick={(e) => { e.preventDefault(); host.navigate(p.id); }}>{p.title}</a>
      ))}
    </nav>
  );
}

function HealthLine({ hosts, updated, reload }: { hosts: PveHost[]; updated?: string; reload: () => Promise<void> }) {
  const offline = hosts.filter((h) => !h.online);
  const old = hosts.filter((h) => h.online && stale(h));
  const [refreshing, setRefreshing] = useState(false);
  // members of one cluster report the same thing; the first one that knows it is enough
  const cluster = hosts.map((h) => h.current?.cluster).find((c) => c?.name);
  const down = (cluster?.nodes || []).filter((n) => !n.online).map((n) => n.name);
  return (
    <div className={`pve-health${offline.length || old.length || cluster?.quorate === false ? " bad" : ""}`} role="status">
      <span className="pve-health-dot" aria-hidden="true" />
      <span>
        {offline.length
          ? `Нет связи: ${offline.map((h) => h.name).join(", ")}.`
          : old.length ? `Устаревшие данные: ${old.map((h) => h.name).join(", ")}.`
          : `На связи: ${hosts.map((h) => h.name).join(", ")}.`}
      </span>
      {cluster ? (
        <span className={`pve-cluster${cluster.quorate && !down.length ? "" : " bad"}`}>
          Кластер <b>{cluster.name}</b> · {cluster.quorate ? "кворум есть" : "нет кворума"} · узлов {(cluster.nodes || []).length}{down.length ? ` · не в сети: ${down.join(", ")}` : ""}
        </span>
      ) : null}
      <span className="pve-muted">Обновлено {ago(updated)} · сбор на хостах каждые 10 с</span>
      <button type="button" className="pve-btn ghost" disabled={refreshing} onClick={() => { setRefreshing(true); void reload().finally(() => setRefreshing(false)); }}><Icon name="refresh" size={14} />{refreshing ? "Обновляю…" : "Обновить"}</button>
    </div>
  );
}

function PveModule({ host }: { host: Host }) {
  const page = usePage();
  const { data, error, loading, reload } = useOverview(host);
  const [selected, setSelected] = useState("");
  const hosts = data?.hosts || [];
  useEffect(() => { if (hosts.length && !hosts.some((h) => h.id === selected)) setSelected(hosts[0].id); }, [hosts, selected]);
  const current = PAGES.some((p) => p.id === page) ? page : "pve";
  const updated = hosts.map((h) => h.checked_at || "").sort().slice(-1)[0];
  let body;
  if (loading && !data) body = <div className="pve-page"><div className="pve-skeleton" /><div className="pve-skeleton tall" /></div>;
  else if (!data) body = <Empty title="Интеграция не отвечает">{error}</Empty>;
  else if (current === "pvesettings") body = <Settings host={host} onSaved={reload} />;
  else if (!data.configured) body = <Empty title="Сервера не настроены">{data.error || "Добавьте их на странице «Настройка»."}</Empty>;
  else if (current === "pveguests") body = <Guests host={host} hosts={hosts} />;
  else if (current === "pvehw") body = <Hardware host={host} hosts={hosts} />;
  else if (current === "pvestorage") body = <Storage hosts={hosts} />;
  else body = <Overview host={host} hosts={hosts} selected={selected} onSelect={setSelected} />;
  return (
    <div className="pve-module">
      <Tabs page={current} host={host} />
      {data?.configured && current !== "pvesettings" ? <HealthLine hosts={hosts} updated={updated} reload={reload} /> : null}
      {error && data ? <div className="pve-health bad" role="alert"><span className="pve-health-dot" aria-hidden="true" />Не удалось обновить: {error}. Показаны последние данные.</div> : null}
      <Management host={host} hosts={hosts} enabled={!!data?.configured} onRefresh={reload}>{body}</Management>
    </div>
  );
}

export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><PveModule host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
