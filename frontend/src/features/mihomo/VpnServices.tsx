import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, type PageKey } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { errText } from "../../lib/format";
import { core, type ServiceState, type ServicesReport } from "./api";
import { ServicesEditor } from "./ServicesEditor";
import { Bars, Pill, ServiceDetail, pathText, serviceTone, leafName, type Tone } from "./VpnOverview";

/*
 * VPN → «Сервисы» (NPM-51): every service people use, filters, and the
 * details of the chosen one beside the list instead of a drawer.
 */

type Filter = "all" | "bad" | "bypass" | "direct";
const viaBypass = (s: ServiceState) => (s.path || []).some((n) => n === "Обходы" || n === "Каскад" || /обход|⛓/i.test(n));
const viaDirect = (s: ServiceState) => leafName(s.path) === "DIRECT" || s.kind === "dns";

export function VpnServices({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const [svc, setSvc] = useState<ServicesReport | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState(() => decodeURIComponent(location.hash.split("/")[2] || ""));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const pull = useCallback(() => void core.services().then(setSvc).catch((e) => setErr(errText(e))), []);
  useEffect(() => {
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 30000);
    return () => clearInterval(t);
  }, [pull]);
  useEffect(() => {
    const next = `#/vpnsvc${open ? `/${encodeURIComponent(open)}` : ""}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }, [open]);

  const check = async (id = "") => {
    setBusy(id || "all");
    setErr("");
    try {
      setSvc(await core.checkServices(id));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const slow = svc?.slow_ms || 1000;
  const list = svc?.services || [];
  const tones = useMemo(() => Object.fromEntries(list.map((s) => [s.id, serviceTone(s, slow)])), [list, slow]);
  const bad = (s: ServiceState) => tones[s.id]?.tone === "bad" || tones[s.id]?.tone === "warn";
  const filters: Array<[Filter, string, number]> = [
    ["all", "Все", list.length],
    ["bad", "Проблемы", list.filter(bad).length],
    ["bypass", "Через обходы", list.filter(viaBypass).length],
    ["direct", "Напрямую", list.filter(viaDirect).length],
  ];
  const shown = list.filter((s) => (filter === "bad" ? bad(s) : filter === "bypass" ? viaBypass(s) : filter === "direct" ? viaDirect(s) : true));
  const current = list.find((s) => s.id === open);
  const okCount = (s: ServiceState) => s.history.filter((r) => r.ok).length;

  return (
    <div className="stack vn">
      <PageHeader
        page="vpnsvc"
        actions={
          <button className="btn btn-sm" disabled={!!busy} onClick={() => void check()}>
            <Icon name="refresh" size={14} /> {busy === "all" ? "Проверяю…" : "Проверить всё"}
          </button>
        }
      />
      {err ? <p className="vn-err">{err}</p> : null}
      <div className="vn-section-head">
        <div className="vn-chips" role="group" aria-label="Фильтр">
          {filters.map(([k, label, n]) => (
            <button key={k} className={`vn-chip${filter === k ? " is-on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label} <span className="vs-count">{n}</span>
            </button>
          ))}
        </div>
        <button className="vn-chip" onClick={() => setEditing(true)} disabled={!svc}>
          <Icon name="edit" size={13} /> Настроить список
        </button>
      </div>

      <div className="vs-layout">
        <div className="vn-grid vs-grid">
          {shown.map((s) => {
            const t = tones[s.id] as { tone: Tone; text: string };
            const last = s.history[s.history.length - 1];
            return (
              <button key={s.id} className={`vn-card${t.tone === "bad" ? " is-bad" : ""}${s.id === open ? " is-sel" : ""}`} aria-pressed={s.id === open} onClick={() => setOpen(s.id === open ? "" : s.id)}>
                <span className="vn-card-top">
                  <span className="vn-mono" aria-hidden="true">
                    {s.name.slice(0, 2)}
                  </span>
                  <span className="vn-card-name" title={`${s.name} — ${pathText(s)}`}>
                    <b>{s.name}</b>
                    <small className="truncate">{pathText(s)}</small>
                  </span>
                  <span className="vs-ms">{last?.ok ? `${last.ms} мс` : "—"}</span>
                </span>
                <Bars s={s} slow={slow} />
                <span className="vn-card-foot">
                  <Pill tone={t.tone}>{t.text}</Pill>
                  <span>{s.history.length ? `${okCount(s)} из ${s.history.length} проверок` : ""}</span>
                </span>
              </button>
            );
          })}
          {!list.length ? <p className="mh-muted">Первая проверка сервисов пройдёт через минуту после запуска HomeNet.</p> : null}
          {list.length && !shown.length ? <p className="mh-muted">Под этот фильтр ничего не попало.</p> : null}
        </div>
        {current ? (
          <aside className="vs-panel" aria-label={current.name}>
            <div className="vs-panel-head">
              <span className="vn-mono vs-mono-big" aria-hidden="true">
                {current.name.slice(0, 2)}
              </span>
              <span className="vn-card-name">
                <b>{current.name}</b>
                <small>
                  {current.what}
                  {current.url ? ` · ${current.url}` : ""}
                </small>
              </span>
              <button className="btn btn-sm btn-icon" aria-label="Закрыть" onClick={() => setOpen("")}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <ServiceDetail s={current} slow={slow} busy={busy === current.id} onCheck={() => void check(current.id)} onNodes={() => onNavigate("proxies")} />
          </aside>
        ) : null}
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} size="lg" title="Чем пользуются дома" description="Свои сервисы, скрытые и порядок карточек">
        {editing && svc ? (
          <ServicesEditor
            catalog={svc.catalog}
            config={svc.config}
            onCancel={() => setEditing(false)}
            onSave={async (c) => {
              setSvc(await core.saveServicesConfig(c));
              setEditing(false);
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
