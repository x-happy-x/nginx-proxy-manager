import { useEffect, useState } from "react";
import { Guests } from "../features/pve/Guests";
import { Hardware } from "../features/pve/Hardware";
import { ago, useOverview, type PveHost } from "../features/pve/model";
import { Overview } from "../features/pve/Overview";
import { Empty } from "../features/pve/parts";
import { Storage } from "../features/pve/Storage";
import "../features/pve/pve.css";
import { ModuleBoundary, usePage } from "./module-base";
import type { Host } from "./sdk";

// NPM-74: Proxmox hosts over SSH. Core's menu lists these sections; when the
// module runs without Core's menu it shows the same list as its own tabs.
const PAGES: { id: string; title: string }[] = [
  { id: "pve", title: "Обзор" },
  { id: "pveguests", title: "Машины" },
  { id: "pvehw", title: "Железо и температуры" },
  { id: "pvestorage", title: "Хранилища" },
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

function HealthLine({ hosts, updated }: { hosts: PveHost[]; updated?: string }) {
  const offline = hosts.filter((h) => !h.online);
  return (
    <div className={`pve-health${offline.length ? " bad" : ""}`} role="status">
      <span className="pve-health-dot" aria-hidden="true" />
      <span>
        {offline.length
          ? `Нет связи: ${offline.map((h) => h.name).join(", ")}. Остальные хосты на связи.`
          : `Все хосты на связи: ${hosts.map((h) => h.name).join(", ")}.`}
      </span>
      <span className="pve-muted">Обновлено {ago(updated)} · сбор на хостах каждые 10 с</span>
    </div>
  );
}

function PveModule({ host }: { host: Host }) {
  const page = usePage();
  const { data, error, loading } = useOverview(host);
  const [selected, setSelected] = useState("");
  const hosts = data?.hosts || [];
  useEffect(() => { if (!selected && hosts.length) setSelected(hosts[0].id); }, [hosts, selected]);
  const current = PAGES.some((p) => p.id === page) ? page : "pve";
  const updated = hosts.map((h) => h.checked_at || "").sort().slice(-1)[0];
  let body;
  if (loading && !data) body = <div className="pve-page"><div className="pve-skeleton" /><div className="pve-skeleton tall" /></div>;
  else if (!data) body = <Empty title="Интеграция не отвечает">{error}</Empty>;
  else if (!data.configured) body = <Empty title="Хосты Proxmox не настроены">{data.error || "Добавьте хосты в /opt/etc/homenet/pve/hosts.json и установите агент."}</Empty>;
  else if (current === "pveguests") body = <Guests host={host} hosts={hosts} />;
  else if (current === "pvehw") body = <Hardware host={host} hosts={hosts} />;
  else if (current === "pvestorage") body = <Storage hosts={hosts} />;
  else body = <Overview host={host} hosts={hosts} selected={selected} onSelect={setSelected} />;
  return (
    <div className="pve-module">
      <Tabs page={current} host={host} />
      {data?.configured ? <HealthLine hosts={hosts} updated={updated} /> : null}
      {error && data ? <div className="pve-health bad" role="alert"><span className="pve-health-dot" aria-hidden="true" />Не удалось обновить: {error}. Показаны последние данные.</div> : null}
      {body}
    </div>
  );
}

export function mount(element: HTMLElement, host: Host) {
  if (host.protocol !== 1) throw new Error("Несовместимая версия HomeNet");
  const root = host.createRoot(element);
  root.render(<ModuleBoundary><PveModule host={host} /></ModuleBoundary>);
  return () => root.unmount();
}
