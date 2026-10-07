import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, EmptyState } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { DEFAULT_TEST_URL, mihomo, type MProvider, type MProxy } from "./api";
import { useMihomo } from "./context";
import { Delay, lastDelay } from "./shared";
import { HealthDots, NodeTiles, arrange, dotOfDelay, providerHealth, useNodePrefs, type NodePrefs, type NodeView } from "./NodeTiles";
import { GROUP_TYPES, Nodes } from "./Nodes";
import { OlcrtcTab } from "./Extras";
import { TailscaleView } from "./TailscaleView";

const TYPE_LABEL: Record<string, string> = { Selector: "выбор", URLTest: "url-test", Fallback: "fallback", LoadBalance: "балансировка", Smart: "smart", Relay: "цепочка" };
const ORDER_KEY = "homenet.mihomo.groupOrder";

function readOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}


export function Proxies() {
  const { configs } = useMihomo();
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const [order, setOrderState] = useState<string[]>(readOrder);
  const [ordering, setOrdering] = useState(false);
  const setOrder = (next: string[]) => {
    setOrderState(next);
    try {
      if (next.length) localStorage.setItem(ORDER_KEY, JSON.stringify(next));
      else localStorage.removeItem(ORDER_KEY);
    } catch {
      /* per-browser preference */
    }
  };

  const load = useCallback(async () => {
    try {
      const all = await mihomo.allProxies();
      setProxies(all.proxies);
      setProviders(all.providers);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const groups = useMemo(() => {
    // Own order first (set in «Порядок групп»), then the order of config.yaml.
    const cfg = proxies.GLOBAL?.all || [];
    const rank = (name: string) => {
      const own = order.indexOf(name);
      if (own >= 0) return own;
      const i = cfg.indexOf(name);
      return 1e4 + (i < 0 ? 1e6 : i);
    };
    const list = Object.values(proxies).filter((p) => GROUP_TYPES.has(p.type) && !p.hidden && (p.name !== "GLOBAL" || configs?.mode === "global"));
    return list.sort((a, b) => rank(a.name) - rank(b.name));
  }, [proxies, configs?.mode, order]);

  return (
    <div className="stack">
      <PageHeader
        page="proxies"
        actions={
          <button type="button" className="btn" onClick={() => void load()}>
            <Icon name="refresh" />
            Обновить
          </button>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      {ordering ? (
        <>
          <GroupOrder groups={groups.map((g) => g.name)} custom={order.length > 0} onChange={setOrder} />
          <button type="button" className="btn btn-primary" style={{ justifySelf: "start" }} onClick={() => setOrdering(false)}>
            Готово
          </button>
        </>
      ) : Object.keys(proxies).length ? (
        <Nodes
          proxies={proxies}
          providers={providers}
          groups={groups}
          onReload={load}
          orderButton={
            <button type="button" className="vn-chip" onClick={() => setOrdering(true)}>
              <Icon name="grip" size={13} /> Порядок групп
            </button>
          }
        />
      ) : !error ? (
        <p className="mh-muted">Загружаю узлы…</p>
      ) : (
        <EmptyState icon="layers" title="Узлов нет">
          mihomo не отдал узлы.
        </EmptyState>
      )}
    </div>
  );
}

/** A page of its own for one kind of extra node (NPM-56): Tailscale, OLCRTC. */
function useAllProxies() {
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const all = await mihomo.allProxies();
      setProxies(all.proxies);
      setProviders(all.providers);
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  return { proxies, providers, error, load };
}

export function TailscalePage() {
  const { proxies, error } = useAllProxies();
  const nodes = Object.values(proxies).filter((x) => x.type.toLowerCase() === "tailscale");
  return (
    <div className="stack">
      <PageHeader page="tailscale" />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      {nodes.length ? (
        <TailscaleView nodes={nodes} />
      ) : (
        <EmptyState icon="network" title="Узла Tailscale нет">
          Добавьте узел Tailscale в «Настройка → Свои узлы».
        </EmptyState>
      )}
    </div>
  );
}

export function OlcrtcPage() {
  const { proxies, providers, error, load } = useAllProxies();
  const prefs = useNodePrefs();
  const isOlc = (x: MProxy) => x.type.toLowerCase() === "olcrtc";
  const providerList = Object.values(providers).filter((p) => p.vehicleType !== "Compatible");
  const olcProviders = providerList.filter((p) => p.proxies.some(isOlc));
  const inProviders = new Set(olcProviders.flatMap((p) => p.proxies.map((x) => x.name)));
  const standalone = Object.values(proxies).filter((x) => isOlc(x) && !inProviders.has(x.name));
  const groups = Object.values(proxies).filter((p) => GROUP_TYPES.has(p.type) && !p.hidden);
  return (
    <div className="stack">
      <PageHeader page="olcrtc" />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      <OlcrtcTab providers={olcProviders} standalone={standalone} groups={groups} onReload={load} prefs={prefs} />
    </div>
  );
}

export function GroupCard({
  g,
  view,
  open,
  onToggle,
  nodes,
  proxies,
  delayOf,
  testing,
  onTestGroup,
  onTestNode,
  onSelect,
  onUnfix,
  hideDead = false,
}: {
  g: MProxy;
  view: NodeView;
  open: boolean;
  onToggle: () => void;
  nodes: string[];
  proxies: Record<string, MProxy>;
  delayOf: (name: string, url?: string) => number | null;
  testing: Record<string, boolean>;
  onTestGroup: () => void;
  onTestNode: (name: string) => void;
  onSelect: (name: string) => void;
  onUnfix: () => void;
  hideDead?: boolean;
}) {
  const selectable = g.type !== "LoadBalance";
  return (
    <section className="card card-flush mh-group">
      <header className="mh-ghead">
        <button type="button" className="mh-ghead-main" aria-expanded={open} onClick={onToggle}>
          <span className="mh-ghead-title">
            <strong>{g.name}</strong>
            <span className="mh-ghead-type">{TYPE_LABEL[g.type] || g.type}</span>
            {g.fixed ? <span className="badge badge-warning" title="Узел закреплён вручную">закреплён</span> : null}
          </span>
          <span className="mh-ghead-now">
            {g.now ? `→ ${g.now}` : "узел не выбран"} · {number((g.all || []).length)}
          </span>
        </button>
        <span className="mh-ghead-side">
          <Delay value={g.now ? delayOf(g.now, g.testUrl) : null} testing={testing[g.name]} />
          {g.fixed ? (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onUnfix} aria-label="Снять закрепление" title="Снять закрепление">
              <Icon name="lock" />
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onTestGroup} disabled={testing[g.name]} aria-label="Проверить задержку узлов группы" title="Проверить задержку узлов группы">
            <Icon name="bolt" />
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onToggle} aria-label={open ? "Свернуть" : "Развернуть"}>
            <Icon name={open ? "chevronDown" : "chevronRight"} />
          </button>
        </span>
      </header>
      {open ? (
        <NodeTiles
          view={view}
          disabled={!selectable}
          items={nodes.map((name) => {
            const node = proxies[name];
            const d = delayOf(name, g.testUrl);
            const isGroup = node && GROUP_TYPES.has(node.type);
            return {
              key: name,
              name,
              meta: [isGroup ? "группа" : (node?.type || "").toLowerCase(), node?.["dialer-proxy"] ? `через ${node["dialer-proxy"]}` : ""].filter(Boolean).join(" · "),
              delay: d,
              testing: testing[`n:${name}`],
              active: g.now === name,
              dead: d === 0,
              onSelect: selectable ? () => onSelect(name) : undefined,
              onTest: () => onTestNode(name),
            };
          })}
        />
      ) : (
        <HealthDots dots={(g.all || []).map((n) => dotOfDelay(n, n, delayOf(n, g.testUrl)))} hideDead={hideDead} open={false} onToggle={onToggle} label={`Узлы (${(g.all || []).length})`} />
      )}
    </section>
  );
}

/** «Порядок групп»: drag rows or use the arrows; kept per browser. */
function GroupOrder({ groups, custom, onChange }: { groups: string[]; custom: boolean; onChange: (next: string[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= groups.length || from === to) return;
    const next = [...groups];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Порядок групп</h2>
          <p className="cell-sub">Перетащите строку или двигайте стрелками. Порядок хранится в этом браузере, config.yaml не меняется.</p>
        </div>
        <button type="button" className="btn btn-sm" disabled={!custom} onClick={() => onChange([])}>
          Как в конфиге
        </button>
      </div>
      <div className="mh-order">
        {groups.map((name, i) => (
          <div
            key={name}
            className={`mh-order-row${drag === i ? " is-drag" : ""}${over === i && drag !== i ? " is-over" : ""}`}
            draggable
            onDragStart={(e) => {
              setDrag(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              if (drag != null) move(drag, i);
              setDrag(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
          >
            <span className="mh-order-grip" aria-hidden="true">
              <Icon name="grip" />
            </span>
            <span className="mh-muted mono">{i + 1}</span>
            <strong>{name}</strong>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Поднять ${name}`}>
              ↑
            </button>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={i === groups.length - 1} onClick={() => move(i, i + 1)} aria-label={`Опустить ${name}`}>
              ↓
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProviderCard({ p, prefs, onReload, onChecks }: { p: MProvider; prefs: NodePrefs; onReload: () => Promise<void>; onChecks: () => void }) {
  const { view, sort, hideDead } = prefs;
  const { act } = useMihomo();
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const info = p.subscriptionInfo;
  const used = info ? (info.Download || 0) + (info.Upload || 0) : 0;
  const total = info?.Total || 0;
  const expire = info?.Expire ? new Date(info.Expire * 1000) : null;
  const daysLeft = expire ? Math.ceil((expire.getTime() - Date.now()) / 86400000) : null;
  // «отвечают»: admitted by the adaptive check when the provider has one, else the last check answered
  const health = providerHealth(p);
  const admitted = (name: string) => p.adaptive?.results?.[name]?.available;
  const deadOf = (x: MProxy) => lastDelay(x, p.testUrl) === 0 || admitted(x.name) === false;
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    await act(`Подписка ${p.name}`, fn, done);
    setBusy("");
    await onReload();
  };
  return (
    <section className="card card-flush mh-group">
      <header className="mh-ghead">
        <button type="button" className="mh-ghead-main" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="mh-ghead-title">
            <strong>{p.name}</strong>
            <span className="mh-ghead-type">{p.vehicleType.toLowerCase()}</span>
            {p.adaptive?.mode ? <AdaptiveModeBadge mode={p.adaptive.mode} /> : null}
          </span>
          <span className="mh-ghead-now">
            {number(health.total)} узлов · {number(health.alive)} {p.adaptive ? "допущено" : "отвечают"}
            {health.unchecked ? ` · ${number(health.unchecked)} не проверены` : ""}{p.updatedAt ? ` · обновлена ${dateTime(p.updatedAt)}` : ""}
          </span>
        </button>
        <span className="mh-ghead-side">
          {p.adaptive ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onChecks} title="Рейтинги и режим сети этой подписки">
              Проверка
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={!!busy} onClick={() => void run("hc", () => mihomo.healthcheck(p.name), "Проверка узлов запущена")} aria-label="Проверить узлы" title="Проверить узлы">
            {busy === "hc" ? <span className="spinner" /> : <Icon name="bolt" />}
          </button>
          {p.vehicleType === "HTTP" ? (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={!!busy} onClick={() => void run("upd", () => mihomo.updateProvider(p.name), "Подписка обновлена")} aria-label="Обновить подписку" title="Обновить подписку">
              {busy === "upd" ? <span className="spinner" /> : <Icon name="refresh" />}
            </button>
          ) : null}
        </span>
      </header>
      {info && (total || expire) ? (
        <div className="mh-sub">
          {total ? (
            <>
              <div className="mh-sub-row">
                <span>
                  Трафик: {bytes(used)} из {bytes(total)}
                </span>
                {expire ? <span>до {expire.toLocaleDateString("ru-RU")} · {daysLeft! > 0 ? `${daysLeft} дн.` : "истекла"}</span> : null}
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.min(100, (used / total) * 100)}%` }} />
              </div>
            </>
          ) : expire ? (
            <div className="mh-sub-row">
              <span>Без лимита трафика</span>
              <span>до {expire.toLocaleDateString("ru-RU")}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <HealthDots
        dots={p.proxies.map((x) => {
          const d = dotOfDelay(x.name, x.name, lastDelay(x, p.testUrl));
          const a = p.adaptive?.results?.[x.name];
          // the adaptive verdict wins over the last HEAD check
          if (a && !a.skipped && !a.available) return { ...d, tone: "bad" as const, title: `${x.name}: не прошёл проверку подписки` };
          if (a?.skipped) return { ...d, tone: "none" as const, title: `${x.name}: ждёт базовую проверку` };
          return d;
        })} hideDead={hideDead} open={open} onToggle={() => setOpen(!open)} label={`Узлы (${p.proxies.length})`} />
      {open ? (
        <NodeTiles
          view={view}
          empty={hideDead ? "Все узлы подписки сейчас недоступны." : undefined}
          items={arrange(
            p.proxies.map((x) => {
            const d = lastDelay(x, p.testUrl);
            return {
              key: x.name,
              name: x.name,
              meta: [x.type.toLowerCase(), x["dialer-proxy"] ? `через ${x["dialer-proxy"]}` : ""].filter(Boolean).join(" · "),
              delay: d,
              dead: deadOf(x),
              testing: testing[x.name],
              onTest: async () => {
                setTesting((t) => ({ ...t, [x.name]: true }));
                try {
                  await mihomo.delay(x.name, p.testUrl || DEFAULT_TEST_URL);
                } catch {
                  /* failure lands in history */
                }
                setTesting((t) => ({ ...t, [x.name]: false }));
                await onReload();
              },
            };
          }),
            sort,
            hideDead,
          )}
        />
      ) : null}
    </section>
  );
}

export function AdaptiveModeBadge({ mode }: { mode: string }) {
  const map: Record<string, [string, string]> = {
    normal: ["badge-success", "сеть без ограничений"],
    whitelist: ["badge-warning", "белые списки"],
    offline: ["badge-danger", "нет сети"],
    unknown: ["", "режим не определён"],
  };
  const [cls, label] = map[mode] || map.unknown;
  return <span className={`badge ${cls}`}>{label}</span>;
}
