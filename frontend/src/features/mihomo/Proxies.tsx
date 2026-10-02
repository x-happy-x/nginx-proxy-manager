import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, EmptyState, SearchInput, Segmented } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { DEFAULT_TEST_URL, mihomo, type MProvider, type MProxy } from "./api";
import { useMihomo } from "./context";
import { Delay, TabCount, Tabs, lastDelay } from "./shared";
import { HealthDots, NodeTiles, NodeViewSwitch, dotOfDelay, useNodeView, type NodeView } from "./NodeTiles";
import { OlcrtcTab, TailscaleTab } from "./Extras";

type Tab = "groups" | "providers" | "tailscale" | "olcrtc";
type Sort = "default" | "name" | "delay";
const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Smart", "Relay"]);
const TYPE_LABEL: Record<string, string> = { Selector: "выбор", URLTest: "url-test", Fallback: "fallback", LoadBalance: "балансировка", Smart: "smart", Relay: "цепочка" };
const COLLAPSE_KEY = "homenet.mihomo.collapsed";
const ORDER_KEY = "homenet.mihomo.groupOrder";

function readOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function Proxies({ onChecks }: { onChecks: () => void }) {
  const { act, configs } = useMihomo();
  const [tab, setTab] = useHashTab<Tab>("proxies", "groups");
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("default");
  const [hideDead, setHideDead] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [view, setView] = useNodeView();
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

  const toggle = (name: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* per-browser preference */
      }
      return next;
    });

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

  // Follow group → now → … to the node that actually carries traffic.
  const leaf = useCallback(
    (name: string): MProxy | undefined => {
      let cur = proxies[name];
      for (let i = 0; cur && cur.now && i < 10; i++) cur = proxies[cur.now];
      return cur;
    },
    [proxies],
  );
  const delayOf = useCallback((name: string, url?: string) => lastDelay(leaf(name), url), [leaf]);

  const testGroup = async (g: MProxy) => {
    setTesting((t) => ({ ...t, [g.name]: true }));
    await act(`Проверка группы ${g.name}`, () => mihomo.groupDelay(g.name, g.testUrl || DEFAULT_TEST_URL), "Задержки обновлены");
    setTesting((t) => ({ ...t, [g.name]: false }));
    await load();
  };
  const testNode = async (name: string, url?: string) => {
    setTesting((t) => ({ ...t, [`n:${name}`]: true }));
    try {
      await mihomo.delay(name, url || DEFAULT_TEST_URL);
    } catch {
      /* failure is recorded in history as 0 */
    }
    setTesting((t) => ({ ...t, [`n:${name}`]: false }));
    await load();
  };
  const select = async (g: MProxy, name: string) => {
    if (g.now === name) return;
    if (await act(`Группа ${g.name}`, () => mihomo.select(g.name, name), `Выбран узел ${name}`)) await load();
  };

  const visibleNodes = (g: MProxy) => {
    const q = query.trim().toLowerCase();
    let names = (g.all || []).filter((n) => !q || n.toLowerCase().includes(q) || g.name.toLowerCase().includes(q));
    if (hideDead) names = names.filter((n) => (delayOf(n, g.testUrl) ?? 1) > 0);
    if (sort === "name") names = [...names].sort((a, b) => a.localeCompare(b));
    if (sort === "delay")
      names = [...names].sort((a, b) => {
        const da = delayOf(a, g.testUrl);
        const db = delayOf(b, g.testUrl);
        const va = da == null ? 1e6 : da <= 0 ? 1e7 : da;
        const vb = db == null ? 1e6 : db <= 0 ? 1e7 : db;
        return va - vb;
      });
    return names;
  };

  const providerList = Object.values(providers).filter((p) => p.vehicleType !== "Compatible" && p.name !== "default");
  const isOlc = (x: MProxy) => x.type.toLowerCase() === "olcrtc";
  const tsNodes = Object.values(proxies).filter((x) => x.type.toLowerCase() === "tailscale");
  const olcProviders = providerList.filter((p) => p.proxies.some(isOlc));
  const olcInProviders = new Set(olcProviders.flatMap((p) => p.proxies.map((x) => x.name)));
  const olcStandalone = Object.values(proxies).filter((x) => isOlc(x) && !olcInProviders.has(x.name));
  const olcCount = olcProviders.reduce((n, p) => n + p.proxies.filter(isOlc).length, 0) + olcStandalone.length;
  const tabs: Array<[Tab, React.ReactNode]> = [
    ["groups", <>Группы <TabCount n={groups.length} /></>],
    ["providers", <>Провайдеры <TabCount n={providerList.length} /></>],
  ];
  if (tsNodes.length) tabs.push(["tailscale", <>Tailscale <TabCount n={tsNodes.length} /></>]);
  if (olcCount) tabs.push(["olcrtc", <>OLCRTC <TabCount n={olcCount} /></>]);
  const loaded = Object.keys(proxies).length > 0;
  const shownTab: Tab = !loaded || tabs.some(([id]) => id === tab) ? tab : "groups";

  return (
    <div className="stack">
      <PageHeader
        page="proxies"
        actions={
          <>
            <button type="button" className="btn" onClick={() => void load()}>
              <Icon name="refresh" />
              Обновить
            </button>
            {shownTab === "groups" ? (
              <button type="button" className="btn btn-primary" onClick={() => groups.forEach((g) => void testGroup(g))} disabled={!groups.length}>
                <Icon name="bolt" />
                Проверить все
              </button>
            ) : shownTab === "providers" ? (
              <button type="button" className="btn btn-primary" onClick={() => providerList.forEach((p) => void act(`Подписка ${p.name}`, () => mihomo.updateProvider(p.name), "Обновлена").then(load))} disabled={!providerList.length}>
                <Icon name="refresh" />
                Обновить подписки
              </button>
            ) : null}
          </>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      <Tabs<Tab>
        label="Раздел прокси"
        value={shownTab}
        onChange={setTab}
        items={tabs}
      />
      {shownTab === "groups" ? (
        <>
          <div className="toolbar">
            <SearchInput label="Поиск узла или группы" placeholder="Узел или группа" value={query} onChange={setQuery} />
            <Segmented<Sort>
              label="Порядок узлов"
              value={sort}
              onChange={setSort}
              options={[
                { value: "default", label: "Как в конфиге" },
                { value: "name", label: "По имени" },
                { value: "delay", label: "По задержке" },
              ]}
            />
            <NodeViewSwitch value={view} onChange={setView} />
            <label className="mh-check">
              <input type="checkbox" checked={hideDead} onChange={(e) => setHideDead(e.target.checked)} />
              Скрыть недоступные
            </label>
            <button type="button" className={`btn btn-sm${ordering ? " btn-primary" : ""}`} onClick={() => setOrdering(!ordering)} aria-pressed={ordering}>
              <Icon name="grip" />
              {ordering ? "Готово" : "Порядок групп"}
            </button>
          </div>
          {ordering ? (
            <GroupOrder groups={groups.map((g) => g.name)} custom={order.length > 0} onChange={setOrder} />
          ) : groups.length ? (
            <div className="mh-groups">
              {groups.map((g) => (
                <GroupCard
                  key={g.name}
                  g={g}
                  view={view}
                  open={!collapsed[g.name]}
                  onToggle={() => toggle(g.name)}
                  nodes={visibleNodes(g)}
                  proxies={proxies}
                  delayOf={delayOf}
                  testing={testing}
                  onTestGroup={() => void testGroup(g)}
                  onTestNode={(n) => void testNode(n, g.testUrl)}
                  onSelect={(n) => void select(g, n)}
                  onUnfix={() => void act(`Группа ${g.name}`, () => mihomo.unfix(g.name), "Закрепление снято").then(load)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon="layers" title="Групп нет">
              В config.yaml нет proxy-groups. Добавьте группу в «Конфигурации».
            </EmptyState>
          )}
        </>
      ) : shownTab === "tailscale" ? (
        <TailscaleTab nodes={tsNodes} view={view} onView={setView} />
      ) : shownTab === "olcrtc" ? (
        <OlcrtcTab providers={olcProviders} standalone={olcStandalone} groups={groups} onReload={load} />
      ) : (
        <>
          {providerList.length ? (
            <div className="toolbar">
              <NodeViewSwitch value={view} onChange={setView} />
            </div>
          ) : null}
          <div className="mh-groups">
            {providerList.map((p) => (
              <ProviderCard key={p.name} p={p} view={view} onReload={load} onChecks={onChecks} />
            ))}
            {!providerList.length ? (
              <EmptyState icon="layers" title="Подписок нет">
                Добавьте подписку в «Конфигурация → Подписки».
              </EmptyState>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function GroupCard({
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
        <HealthDots dots={(g.all || []).map((n) => dotOfDelay(n, n, delayOf(n, g.testUrl)))} open={false} onToggle={onToggle} label={`Узлы (${(g.all || []).length})`} />
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

function ProviderCard({ p, view, onReload, onChecks }: { p: MProvider; view: NodeView; onReload: () => Promise<void>; onChecks: () => void }) {
  const { act } = useMihomo();
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const info = p.subscriptionInfo;
  const used = info ? (info.Download || 0) + (info.Upload || 0) : 0;
  const total = info?.Total || 0;
  const expire = info?.Expire ? new Date(info.Expire * 1000) : null;
  const daysLeft = expire ? Math.ceil((expire.getTime() - Date.now()) / 86400000) : null;
  const alive = p.proxies.filter((x) => (lastDelay(x, p.testUrl) ?? 1) > 0).length;
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
            {number(p.proxies.length)} узлов · {number(alive)} отвечают{p.updatedAt ? ` · обновлена ${dateTime(p.updatedAt)}` : ""}
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
      <HealthDots dots={p.proxies.map((x) => dotOfDelay(x.name, x.name, lastDelay(x, p.testUrl)))} open={open} onToggle={() => setOpen(!open)} label={`Узлы (${p.proxies.length})`} />
      {open ? (
        <NodeTiles
          view={view}
          items={p.proxies.map((x) => {
            const d = lastDelay(x, p.testUrl);
            return {
              key: x.name,
              name: x.name,
              meta: [x.type.toLowerCase(), x["dialer-proxy"] ? `через ${x["dialer-proxy"]}` : ""].filter(Boolean).join(" · "),
              delay: d,
              dead: d === 0,
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
          })}
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
