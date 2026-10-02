import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, EmptyState, SearchInput, Segmented } from "../../components/ui/controls";
import { bytes, dateTime, errText, number } from "../../lib/format";
import { DEFAULT_TEST_URL, mihomo, type MProvider, type MProxy } from "./api";
import { useMihomo } from "./context";
import { Delay, TabCount, Tabs, lastDelay } from "./shared";
import { OlcrtcTab, TailscaleTab } from "./Extras";

type Tab = "groups" | "providers" | "tailscale" | "olcrtc";
type Sort = "default" | "name" | "delay";
const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Smart", "Relay"]);
const TYPE_LABEL: Record<string, string> = { Selector: "выбор", URLTest: "url-test", Fallback: "fallback", LoadBalance: "балансировка", Smart: "smart", Relay: "цепочка" };
const COLLAPSE_KEY = "homenet.mihomo.collapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function Proxies({ onChecks }: { onChecks: () => void }) {
  const { act, configs } = useMihomo();
  const [tab, setTab] = useState<Tab>("groups");
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("default");
  const [hideDead, setHideDead] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);

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
    const order = proxies.GLOBAL?.all || [];
    const list = Object.values(proxies).filter((p) => GROUP_TYPES.has(p.type) && !p.hidden && (p.name !== "GLOBAL" || configs?.mode === "global"));
    return list.sort((a, b) => {
      const ia = order.indexOf(a.name);
      const ib = order.indexOf(b.name);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
  }, [proxies, configs?.mode]);

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
            {tab === "groups" ? (
              <button type="button" className="btn btn-primary" onClick={() => groups.forEach((g) => void testGroup(g))} disabled={!groups.length}>
                <Icon name="bolt" />
                Проверить все
              </button>
            ) : tab === "providers" ? (
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
        value={tab}
        onChange={setTab}
        items={tabs}
      />
      {tab === "groups" ? (
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
            <label className="mh-check">
              <input type="checkbox" checked={hideDead} onChange={(e) => setHideDead(e.target.checked)} />
              Скрыть недоступные
            </label>
          </div>
          {groups.length ? (
            <div className="mh-groups">
              {groups.map((g) => {
                const nodes = visibleNodes(g);
                const isOpen = !collapsed[g.name];
                const selectable = g.type !== "LoadBalance";
                return (
                  <section className="card card-flush mh-group" key={g.name}>
                    <header className="mh-group-head">
                      <button type="button" className="mh-group-toggle" aria-expanded={isOpen} onClick={() => toggle(g.name)}>
                        <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={16} />
                        <strong>{g.name}</strong>
                        <span className="badge">{TYPE_LABEL[g.type] || g.type}</span>
                      </button>
                      <span className="mh-group-now">
                        {g.now ? <span className="truncate">{g.now}</span> : null}
                        {g.fixed ? <span className="badge badge-warning" title="Узел закреплён вручную">закреплён</span> : null}
                      </span>
                      <span className="mh-group-actions">
                        <Delay value={g.now ? delayOf(g.now, g.testUrl) : null} testing={testing[g.name]} />
                        {g.fixed ? (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(`Группа ${g.name}`, () => mihomo.unfix(g.name), "Закрепление снято").then(load)}>
                            Снять закрепление
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void testGroup(g)} disabled={testing[g.name]} title="Проверить задержку всех узлов группы">
                          <Icon name="bolt" />
                          Проверить
                        </button>
                      </span>
                    </header>
                    {isOpen ? (
                      <div className="mh-nodes">
                        {nodes.map((name) => {
                          const node = proxies[name];
                          const d = delayOf(name, g.testUrl);
                          const isGroup = node && GROUP_TYPES.has(node.type);
                          return (
                            <div key={name} className={`mh-node${g.now === name ? " is-active" : ""}${d === 0 ? " is-dead" : ""}`}>
                              <button
                                type="button"
                                className="mh-node-main"
                                disabled={!selectable}
                                aria-pressed={g.now === name}
                                onClick={() => void select(g, name)}
                                title={selectable ? `Выбрать ${name}` : name}
                              >
                                <span className="mh-node-meta">
                                  <span>{isGroup ? "группа" : (node?.type || "").toLowerCase()}</span>
                                  {node?.["dialer-proxy"] ? <span title="dialer-proxy">через {node["dialer-proxy"]}</span> : null}
                                </span>
                                <span className="mh-node-name">{name}</span>
                              </button>
                              <button type="button" className="mh-node-delay" onClick={() => void testNode(name, g.testUrl)} title="Проверить задержку">
                                <Delay value={d} testing={testing[`n:${name}`]} />
                              </button>
                            </div>
                          );
                        })}
                        {!nodes.length ? <p className="mh-muted">Нет узлов под фильтр.</p> : null}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : (
            <EmptyState icon="layers" title="Групп нет">
              В config.yaml нет proxy-groups. Добавьте группу в «Конфигурации».
            </EmptyState>
          )}
        </>
      ) : tab === "tailscale" ? (
        <TailscaleTab nodes={tsNodes} />
      ) : tab === "olcrtc" ? (
        <OlcrtcTab providers={olcProviders} standalone={olcStandalone} groups={groups} onReload={load} />
      ) : (
        <div className="mh-groups">
          {providerList.map((p) => (
            <ProviderCard key={p.name} p={p} onReload={load} onChecks={onChecks} />
          ))}
          {!providerList.length ? (
            <EmptyState icon="layers" title="Подписок нет">
              Добавьте подписку в «Конфигурация → Подписки».
            </EmptyState>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProviderCard({ p, onReload, onChecks }: { p: MProvider; onReload: () => Promise<void>; onChecks: () => void }) {
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
      <header className="mh-group-head">
        <span className="mh-group-toggle">
          <strong>{p.name}</strong>
          <span className="badge">{p.vehicleType.toLowerCase()}</span>
          {p.adaptive?.mode ? <AdaptiveModeBadge mode={p.adaptive.mode} /> : null}
        </span>
        <span className="mh-group-now cell-sub">
          {number(p.proxies.length)} узлов · {number(alive)} отвечают{p.updatedAt ? ` · обновлена ${dateTime(p.updatedAt)}` : ""}
        </span>
        <span className="mh-group-actions">
          {p.adaptive ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onChecks}>
              Проверка подписки
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void run("hc", () => mihomo.healthcheck(p.name), "Проверка узлов запущена")}>
            {busy === "hc" ? <span className="spinner" /> : <Icon name="bolt" />}
            Проверить узлы
          </button>
          {p.vehicleType === "HTTP" ? (
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void run("upd", () => mihomo.updateProvider(p.name), "Подписка обновлена")}>
              {busy === "upd" ? <span className="spinner" /> : <Icon name="refresh" />}
              Обновить
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
      <button type="button" className="mh-health" aria-expanded={open} aria-label={open ? "Свернуть узлы" : "Показать узлы"} onClick={() => setOpen(!open)}>
        {p.proxies.map((x) => {
          const d = lastDelay(x, p.testUrl);
          return <i key={x.name} className={`is-${d == null ? "none" : d <= 0 ? "bad" : d < 300 ? "good" : d < 800 ? "warn" : "bad"}`} title={`${x.name}: ${d == null ? "не проверялся" : d <= 0 ? "нет ответа" : `${d} мс`}`} />;
        })}
        <span className="mh-health-toggle">
          {open ? "Свернуть" : `Узлы (${p.proxies.length})`}
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </span>
      </button>
      {open ? (
        <div className="mh-nodes">
          {p.proxies.map((x) => (
            <div key={x.name} className={`mh-node${lastDelay(x, p.testUrl) === 0 ? " is-dead" : ""}`}>
              <span className="mh-node-main" title={x.name}>
                <span className="mh-node-meta">
                  <span>{x.type.toLowerCase()}</span>
                  {x["dialer-proxy"] ? <span>через {x["dialer-proxy"]}</span> : null}
                </span>
                <span className="mh-node-name">{x.name}</span>
              </span>
              <button
                type="button"
                className="mh-node-delay"
                title="Проверить задержку"
                onClick={async () => {
                  setTesting((t) => ({ ...t, [x.name]: true }));
                  try {
                    await mihomo.delay(x.name, p.testUrl || DEFAULT_TEST_URL);
                  } catch {
                    /* failure lands in history */
                  }
                  setTesting((t) => ({ ...t, [x.name]: false }));
                  await onReload();
                }}
              >
                <Delay value={lastDelay(x, p.testUrl)} testing={testing[x.name]} />
              </button>
            </div>
          ))}
        </div>
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
