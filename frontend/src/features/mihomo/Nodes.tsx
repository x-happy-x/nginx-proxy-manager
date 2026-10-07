import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../../components/ui/Icon";
import { errText, number } from "../../lib/format";
import { DEFAULT_TEST_URL, core, mihomo, type MProvider, type MProxy, type NodeMeta } from "./api";
import { useMihomo } from "./context";
import { lastDelay } from "./shared";
import { isBool, useStored } from "./NodeTiles";

/*
 * VPN → «Узлы» (NPM-56): one page, four ways to look at the same nodes —
 * group cards with a dot per node, tiles, a dense list and nodes by server —
 * with filters by group, «hide silent», sort and search, and a side panel
 * for the chosen group (pin a node) or node (history, server, SNI, country).
 * Design: https://claude.ai/artifact/8w7GwGhKrK96ePPxL166SG
 */

export const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Smart", "Relay"]);
const TYPE_LABEL: Record<string, string> = { Selector: "выбор", URLTest: "по задержке", Fallback: "первый живой", LoadBalance: "балансировка", Smart: "smart", Relay: "цепочка" };
const SLOW_MS = 1000;

type View = "groups" | "tiles" | "list" | "servers";
type Sort = "delay" | "name";
export type NodeState = "ok" | "slow" | "out" | "reset" | "silent" | "none";

const ST_TEXT: Record<NodeState, string> = { ok: "живой", slow: "медленно", out: "снят на 3 мин", reset: "сброс", silent: "молчит", none: "не проверялся" };
const ST_LONG: Record<NodeState, string> = {
  ok: "отвечает",
  slow: "отвечает дольше секунды",
  out: "снят пассивной проверкой: соединения шли без ответа",
  reset: "соединение сбрасывается — похоже на отсев по SNI",
  silent: "тишина: соединение уходит без ответа — похоже на отсев по IP",
  none: "ещё не проверялся",
};
const FAIL_TEXT: Record<string, string> = { tls: "ошибка TLS", http: "сайт ответил не тем", body: "ответ неполный" };
const ICON: Record<View, string> = {
  groups: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  tiles: "M3 5h5v4H3zM10 5h5v4h-5zM17 5h4v4h-4zM3 11h5v4H3zM10 11h5v4h-5zM17 11h4v4h-4zM3 17h5v3H3zM10 17h5v3h-5z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  servers: "M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01",
};
const VIEWS: Array<[View, string]> = [
  ["groups", "Группы"],
  ["tiles", "Плитки"],
  ["list", "Список"],
  ["servers", "По серверам"],
];

export type NodeRow = {
  name: string;
  provider?: string;
  type: string;
  delay: number | null;
  state: NodeState;
  note: string;
  country?: string;
  history: number[];
  rate?: number;
  meta?: NodeMeta;
};

const ms = (d: number | null) => (d == null ? "—" : d <= 0 ? "нет ответа" : d >= 1000 ? `${(d / 1000).toFixed(1).replace(".", ",")} с` : `${d} мс`);
const subnet = (server?: string) => {
  const m = server?.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : server || "";
};
const sittingOut = (g?: MProxy) => new Set(((g as unknown as { sittingOut?: string[] })?.sittingOut || []) as string[]);

/** Every node the core knows: provider nodes with their adaptive verdicts, then standalone proxies. */
export function useNodeRows(proxies: Record<string, MProxy>, providers: Record<string, MProvider>, groups: MProxy[], meta: Record<string, NodeMeta>) {
  return useMemo(() => {
    const out = new Map<string, NodeRow>();
    const resting = new Set<string>();
    groups.forEach((g) => sittingOut(g).forEach((n) => resting.add(n)));
    const rowOf = (x: MProxy, p?: MProvider): NodeRow => {
      const d = lastDelay(x, p?.testUrl || x.testUrl);
      const a = p?.adaptive?.results?.[x.name];
      const fail = a ? (a.probes || []).find((pr) => !pr.ok && pr.fail)?.fail : undefined;
      const country = a?.country || (a?.probes || []).find((pr) => pr.country)?.country;
      let state: NodeState;
      if (resting.has(x.name)) state = "out";
      else if (a && !a.skipped && !a.available) state = fail === "reset" ? "reset" : "silent";
      else if (d == null) state = "none";
      else if (d <= 0) state = "silent";
      else state = d > SLOW_MS ? "slow" : "ok";
      const rec = (p?.adaptive?.rankings?.[p.adaptive.mode === "whitelist" ? "whitelist" : "normal"] || []).find((r) => r.name === x.name)?.record;
      return {
        name: x.name,
        provider: p?.name,
        type: x.type,
        delay: d,
        state,
        note: fail && FAIL_TEXT[fail] ? FAIL_TEXT[fail] : ST_LONG[state],
        country: country?.toUpperCase(),
        history: (x.history || []).slice(-30).map((h) => h.delay),
        rate: rec && rec.ok + rec.fail ? Math.round((rec.ok / (rec.ok + rec.fail)) * 100) : undefined,
        meta: meta[x.name],
      };
    };
    Object.values(providers)
      .filter((p) => p.vehicleType !== "Compatible")
      .forEach((p) => p.proxies.forEach((x) => out.has(x.name) || out.set(x.name, rowOf(x, p))));
    Object.values(proxies)
      .filter((x) => !GROUP_TYPES.has(x.type) && !["Direct", "Reject", "RejectDrop", "Compatible", "Pass", "Dns"].includes(x.type) && !out.has(x.name))
      .forEach((x) => out.set(x.name, rowOf(x)));
    return out;
  }, [proxies, providers, groups, meta]);
}

function Pill({ state }: { state: NodeState }) {
  return <span className={`nx-pill nx-${state}`}>{ST_TEXT[state]}</span>;
}

export function Nodes({
  proxies,
  providers,
  groups,
  onReload,
  orderButton,
}: {
  proxies: Record<string, MProxy>;
  providers: Record<string, MProvider>;
  groups: MProxy[];
  onReload: () => Promise<void>;
  orderButton?: ReactNode;
}) {
  const { act } = useMihomo();
  const [view, setView] = useStored<View>("homenet.nodes.view", "groups", (v): v is View => VIEWS.some(([k]) => k === v));
  const [sort, setSort] = useStored<Sort>("homenet.nodes.sort", "delay", (v): v is Sort => v === "delay" || v === "name");
  const [hideSilent, setHideSilent] = useStored<boolean>("homenet.mihomo.hideDead", false, isBool);
  const [grp, setGrp] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<{ kind: "group" | "node"; name: string } | null>(null);
  const [meta, setMeta] = useState<Record<string, NodeMeta>>({});
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    void core
      .nodes()
      .then((r) => setMeta(r.nodes))
      .catch(() => undefined);
  }, []);

  const rows = useNodeRows(proxies, providers, groups, meta);
  const leaf = (name: string): string => {
    let cur = proxies[name];
    for (let i = 0; cur && cur.now && i < 10; i++) {
      if (!proxies[cur.now]) return cur.now;
      cur = proxies[cur.now];
    }
    return cur?.name || name;
  };
  const stateOf = (name: string): NodeState => {
    const r = rows.get(name);
    if (r) return r.state;
    const g = proxies[name];
    if (g && GROUP_TYPES.has(g.type)) return rows.get(leaf(name))?.state || "none";
    const d = lastDelay(g);
    return d == null ? "none" : d <= 0 ? "silent" : "ok";
  };
  // groups of nodes first: they are what the chips filter by
  const nodeGroups = groups.filter((g) => (g.all || []).filter((n) => rows.has(n)).length >= Math.max(2, (g.all || []).length / 2));
  const chips = nodeGroups.slice(0, 10);
  const member = useMemo(() => {
    const m = new Map<string, string[]>();
    groups.forEach((g) => (g.all || []).forEach((n) => m.set(n, [...(m.get(n) || []), g.name])));
    return m;
  }, [groups]);

  const query = q.trim().toLowerCase();
  const order: Record<NodeState, number> = { ok: 0, slow: 1, none: 2, out: 3, reset: 4, silent: 5 };
  const list = [...rows.values()]
    .filter((r) => !grp || (proxies[grp]?.all || []).includes(r.name))
    .filter((r) => !hideSilent || (r.state !== "silent" && r.state !== "reset"))
    .filter((r) => !query || `${r.name} ${r.country || ""} ${r.meta?.server || ""} ${r.meta?.sni || ""} ${r.provider || ""}`.toLowerCase().includes(query))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, "ru") : order[a.state] - order[b.state] || (a.delay || 9e9) - (b.delay || 9e9)));
  const alive = [...rows.values()].filter((r) => r.state === "ok" || r.state === "slow").length;

  const pin = async (group: string, node: string) => {
    setBusy(`pin:${node}`);
    setErr("");
    try {
      await mihomo.select(group, node);
      await onReload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };
  const unpin = async (group: string) => {
    setBusy("unpin");
    try {
      await mihomo.unfix(group);
      await onReload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };
  const testNode = async (name: string, url?: string) => {
    setBusy(`t:${name}`);
    try {
      await mihomo.delay(name, url || DEFAULT_TEST_URL);
    } catch {
      /* the failure lands in the history */
    }
    await onReload();
    setBusy("");
  };
  const testGroup = async (g: MProxy) => {
    setBusy(`g:${g.name}`);
    await act(`Проверка группы ${g.name}`, () => mihomo.groupDelay(g.name, g.testUrl || DEFAULT_TEST_URL), "Задержки обновлены");
    await onReload();
    setBusy("");
  };
  const checkAll = async () => {
    setBusy("all");
    await Promise.all(nodeGroups.map((g) => mihomo.groupDelay(g.name, g.testUrl || DEFAULT_TEST_URL).catch(() => undefined)));
    await onReload();
    setBusy("");
  };

  const shownGroups = grp ? groups.filter((g) => g.name === grp) : groups;
  const selGroup = sel?.kind === "group" ? proxies[sel.name] : sel ? undefined : grp ? proxies[grp] : shownGroups[0];
  const selNode = sel?.kind === "node" ? rows.get(sel.name) : undefined;

  // nodes by server: the subnet decides, nodes of one server share their fate
  const servers = useMemo(() => {
    const m = new Map<string, NodeRow[]>();
    list.forEach((r) => {
      const key = subnet(r.meta?.server) || "адрес не известен";
      m.set(key, [...(m.get(key) || []), r]);
    });
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [list]);

  const openNode = (name: string) => setSel({ kind: "node", name });
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});

  return (
    <div className="nx">
      <div className="nx-toolbar">
        <div className="nx-views" role="group" aria-label="Вид">
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" className={view === k ? "is-on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICON[k]} />
              </svg>
              {label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="nx-q">
          Найти узел
        </label>
        <input id="nx-q" className="input nx-search" placeholder="Узел, страна, сервер, SNI" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-primary" disabled={busy === "all"} onClick={() => void checkAll()}>
          <Icon name="bolt" size={14} /> {busy === "all" ? "Проверяю…" : "Проверить все"}
        </button>
      </div>
      <div className="nx-filters">
        <div className="vn-chips nx-chiprow" role="group" aria-label="Группа">
          <button type="button" className={`vn-chip${!grp ? " is-on" : ""}`} aria-pressed={!grp} onClick={() => setGrp("")}>
            Все <span className="vs-count">{number(rows.size)}</span>
          </button>
          {chips.map((g) => (
            <button key={g.name} type="button" className={`vn-chip${grp === g.name ? " is-on" : ""}`} aria-pressed={grp === g.name} onClick={() => (setGrp(grp === g.name ? "" : g.name), setSel(null))}>
              {g.name} <span className="vs-count">{(g.all || []).length}</span>
            </button>
          ))}
        </div>
        <div className="vn-chips">
          <button type="button" className={`vn-chip${hideSilent ? " is-on" : ""}`} aria-pressed={hideSilent} onClick={() => setHideSilent(!hideSilent)}>
            Скрыть молчащие
          </button>
          <button type="button" className="vn-chip" onClick={() => setSort(sort === "delay" ? "name" : "delay")}>
            {sort === "delay" ? "Сначала быстрые" : "По имени"}
          </button>
          {orderButton}
        </div>
      </div>
      <p className="nx-summary">
        {number(alive)} из {number(rows.size)} узлов отвечают{grp ? ` · в «${grp}» ${(proxies[grp]?.all || []).length}` : ""}
        {list.length !== rows.size ? ` · показано ${number(list.length)}` : ""}
      </p>
      {err ? <p className="vn-err">{err}</p> : null}

      <div className="nx-layout">
        <div className="nx-main">
          {view === "groups" ? (
            <div className="nx-groups">
              {shownGroups.map((g) => {
                const members = (g.all || []).filter((n) => !hideSilent || !["silent", "reset"].includes(stateOf(n)));
                const ok = (g.all || []).filter((n) => ["ok", "slow"].includes(stateOf(n))).length;
                const l = leaf(g.name);
                const on = selGroup?.name === g.name && !selNode;
                return (
                  <button key={g.name} type="button" className={`nx-gcard${on ? " is-sel" : ""}`} aria-pressed={on} onClick={() => setSel({ kind: "group", name: g.name })}>
                    <span className="nx-gcard-top">
                      <b className="truncate">{g.name}</b>
                      <span className="nx-count">
                        <span className="nx-ok">{ok}</span> / {(g.all || []).length}
                      </span>
                    </span>
                    <span className="nx-gcard-type">
                      {TYPE_LABEL[g.type] || g.type}
                      {g.fixed ? " · закреплён" : ""}
                    </span>
                    <span className="nx-dots" aria-hidden="true">
                      {members.slice(0, 120).map((n) => (
                        <i key={n} className={`nx-dot nx-${stateOf(n)}`} title={`${n}: ${ST_TEXT[stateOf(n)]}`} />
                      ))}
                      {members.length > 120 ? <small>+{members.length - 120}</small> : null}
                    </span>
                    <span className="nx-gcard-now">
                      <span className="truncate">сейчас {l === "DIRECT" ? "напрямую" : l}</span>
                      <span className="mono">{ms(rows.get(l)?.delay ?? lastDelay(proxies[l], g.testUrl))}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {view === "tiles" ? (
            <div className="nx-tiles">
              {list.slice(0, 400).map((r) => (
                <button key={r.name} type="button" className={`nx-tile nx-t-${r.state}${selNode?.name === r.name ? " is-sel" : ""}`} onClick={() => openNode(r.name)} title={r.note}>
                  <span className="nx-tile-top">
                    {r.country ? <span className="nx-cc">{r.country}</span> : null}
                    <b className="truncate">{r.name}</b>
                  </span>
                  <span className="nx-tile-foot">
                    <Pill state={r.state} />
                    <span className="mono">{r.delay && r.delay > 0 ? ms(r.delay) : ""}</span>
                  </span>
                </button>
              ))}
              {list.length > 400 ? <p className="mh-muted">Показаны первые 400 — уточните поиск или выберите группу.</p> : null}
            </div>
          ) : null}

          {view === "list" ? (
            <div className="nx-table" role="table" aria-label="Узлы">
              <div className="nx-row nx-head" role="row">
                <span role="columnheader">Узел</span>
                <span role="columnheader" className="nx-hm">
                  Подписка
                </span>
                <span role="columnheader">Выход</span>
                <span role="columnheader">Задержка</span>
                <span role="columnheader" className="nx-hm">
                  Успешно
                </span>
                <span role="columnheader" className="nx-hm">
                  Состояние
                </span>
              </div>
              {list.slice(0, 500).map((r) => (
                <button key={r.name} type="button" role="row" className={`nx-row${selNode?.name === r.name ? " is-sel" : ""}`} onClick={() => openNode(r.name)}>
                  <span className="nx-name" role="cell">
                    <i className={`nx-dot nx-${r.state}`} />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <span role="cell" className="nx-hm truncate">
                    {r.provider || "свой узел"}
                  </span>
                  <span role="cell" className="mono">
                    {r.country || "—"}
                  </span>
                  <span role="cell" className="mono">
                    {ms(r.delay)}
                  </span>
                  <span role="cell" className="nx-hm mono">
                    {r.rate != null ? `${r.rate}%` : "—"}
                  </span>
                  <span role="cell" className="nx-hm truncate nx-note">
                    {r.note}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {view === "servers" ? (
            <div className="nx-servers">
              {servers.map(([key, nodes]) => {
                const bad = nodes.filter((r) => r.state === "silent" || r.state === "reset").length;
                const snis = [...new Set(nodes.map((r) => r.meta?.sni).filter(Boolean))];
                const types = [...new Set(nodes.map((r) => r.meta?.type || r.type.toLowerCase()))];
                return (
                  <section key={key} className="nx-server">
                    <header>
                      <span>
                        <b className="mono">{key}</b>
                        <small>
                          {types.join(", ")}
                          {snis.length ? ` · SNI ${snis.slice(0, 3).join(", ")}${snis.length > 3 ? "…" : ""}` : ""} · {nodes.length} узл.
                        </small>
                      </span>
                      <span className={`nx-pill ${bad === 0 ? "nx-ok" : bad < nodes.length ? "nx-slow" : "nx-silent"}`}>{bad === 0 ? "все отвечают" : bad < nodes.length ? `${bad} из ${nodes.length} молчат` : "весь сервер молчит"}</span>
                    </header>
                    <div className="nx-server-nodes">
                      {(unfolded[key] ? nodes : nodes.slice(0, 12)).map((r) => (
                        <button key={r.name} type="button" className={`vn-chip nx-schip${selNode?.name === r.name ? " is-on" : ""}`} onClick={() => openNode(r.name)}>
                          <i className={`nx-dot nx-${r.state}`} />
                          {r.name}
                          <span className="vs-count">{r.delay && r.delay > 0 ? ms(r.delay) : ""}</span>
                        </button>
                      ))}
                      {nodes.length > 12 ? (
                        <button type="button" className="vn-chip" onClick={() => setUnfolded((u) => ({ ...u, [key]: !u[key] }))}>
                          {unfolded[key] ? "Свернуть" : `ещё ${nodes.length - 12}`}
                        </button>
                      ) : null}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : null}
          {!list.length && view !== "groups" ? <p className="mh-muted">Под фильтр ничего не попало.</p> : null}
        </div>

        <aside className="nx-panel">
          {selNode ? (
            <NodePanel
              r={selNode}
              groups={(member.get(selNode.name) || []).map((n) => proxies[n]).filter(Boolean)}
              busy={busy}
              onTest={() => void testNode(selNode.name)}
              onPin={(g) => void pin(g, selNode.name)}
              onServer={() => {
                setView("servers");
                setQ(selNode.meta?.server ? subnet(selNode.meta.server).replace(".0/24", ".") : "");
              }}
              onClose={() => setSel(null)}
            />
          ) : selGroup ? (
            <GroupPanel
              g={selGroup}
              rows={rows}
              stateOf={stateOf}
              leaf={leaf(selGroup.name)}
              delayOf={(n) => rows.get(n)?.delay ?? rows.get(leaf(n))?.delay ?? lastDelay(proxies[leaf(n)])}
              leafOf={(n) => (proxies[n] && GROUP_TYPES.has(proxies[n].type) ? leaf(n) : "")}
              busy={busy}
              onPin={(n) => void pin(selGroup.name, n)}
              onUnpin={() => void unpin(selGroup.name)}
              onTest={() => void testGroup(selGroup)}
              onOpen={(n) => openNode(n)}
              onAll={() => (setGrp(selGroup.name), setView("tiles"))}
            />
          ) : (
            <p className="mh-muted">Выберите группу или узел.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function GroupPanel({
  g,
  rows,
  stateOf,
  leaf,
  delayOf,
  leafOf,
  busy,
  onPin,
  onUnpin,
  onTest,
  onOpen,
  onAll,
}: {
  g: MProxy;
  rows: Map<string, NodeRow>;
  stateOf: (n: string) => NodeState;
  leaf: string;
  delayOf: (n: string) => number | null;
  leafOf: (n: string) => string;
  busy: string;
  onPin: (n: string) => void;
  onUnpin: () => void;
  onTest: () => void;
  onOpen: (n: string) => void;
  onAll: () => void;
}) {
  const all = g.all || [];
  const count = (s: NodeState[]) => all.filter((n) => s.includes(stateOf(n))).length;
  const pinnable = g.type === "Selector" || g.type === "Fallback" || g.type === "URLTest";
  const top = all
    .filter((n) => ["ok", "slow"].includes(stateOf(n)))
    .sort((a, b) => (delayOf(a) || 9e9) - (delayOf(b) || 9e9))
    .slice(0, 8);
  return (
    <div className="nx-pan">
      <div className="nx-pan-head">
        <span className="vn-eyebrow">Группа · {TYPE_LABEL[g.type] || g.type}</span>
        <b>{g.name}</b>
        <small>сейчас {leaf === "DIRECT" ? "напрямую" : leaf}</small>
      </div>
      <div className="nx-stats">
        <div>
          <small>Живы</small>
          <b>
            {count(["ok", "slow"])} / {all.length}
          </b>
        </div>
        <div>
          <small>Молчат</small>
          <b>{count(["silent", "reset"])}</b>
        </div>
        <div>
          <small>Сняты</small>
          <b>{count(["out"])}</b>
        </div>
      </div>
      {g.fixed ? (
        <div className="vr-fixed">
          <Icon name="lock" size={14} />
          <span>Закреплена на «{g.fixed}»</span>
          <button type="button" className="btn btn-sm" disabled={busy === "unpin"} onClick={onUnpin}>
            Снять
          </button>
        </div>
      ) : null}
      <span className="vn-eyebrow">{pinnable ? "Быстрые — нажмите, чтобы закрепить" : "Быстрые"}</span>
      <div className="nx-top">
        {top.map((n) => {
          const fixed = g.fixed === n;
          const sub = leafOf(n);
          return (
            <div key={n} className={`nx-top-row${fixed ? " is-fixed" : ""}${g.now === n ? " is-now" : ""}`}>
              <button type="button" className="nx-top-name" onClick={() => onOpen(sub || n)} title="Подробнее об узле">
                <i className={`nx-dot nx-${stateOf(n)}`} />
                <span className="truncate">
                  {n}
                  {sub ? <small className="nx-sub"> · {sub === "DIRECT" ? "напрямую" : sub}</small> : null}
                </span>
                <span className="mono">{ms(delayOf(n))}</span>
              </button>
              {pinnable && !fixed ? (
                <button type="button" className="btn btn-sm" disabled={busy === `pin:${n}`} onClick={() => onPin(n)}>
                  Закрепить
                </button>
              ) : fixed ? (
                <span className="vn-pill vn-ok">закреплён</span>
              ) : null}
            </div>
          );
        })}
        {!top.length ? <p className="mh-muted">Живых узлов в группе сейчас нет.</p> : null}
      </div>
      <small className="mh-muted">{g.fixed ? "Закрепление снимется само, если узел перестанет отвечать." : "Без закрепления группа сама берёт подходящий узел."}</small>
      <div className="nx-actions">
        <button type="button" className="btn btn-sm" disabled={busy === `g:${g.name}`} onClick={onTest}>
          <Icon name="bolt" size={13} /> {busy === `g:${g.name}` ? "Проверяю…" : "Проверить группу"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onAll}>
          Все {all.length} узлов →
        </button>
      </div>
    </div>
  );
}

function NodePanel({
  r,
  groups,
  busy,
  onTest,
  onPin,
  onServer,
  onClose,
}: {
  r: NodeRow;
  groups: MProxy[];
  busy: string;
  onTest: () => void;
  onPin: (group: string) => void;
  onServer: () => void;
  onClose: () => void;
}) {
  const max = Math.max(400, ...r.history.filter((d) => d > 0));
  const pinnable = groups.filter((g) => g.type === "Selector" || g.type === "Fallback" || g.type === "URLTest");
  return (
    <div className="nx-pan">
      <div className="nx-pan-head nx-pan-head-row">
        <span>
          <span className="vn-eyebrow">Узел{r.provider ? ` · ${r.provider}` : ""}</span>
          <b>{r.name}</b>
          <small>{r.note}</small>
        </span>
        <button type="button" className="btn btn-sm btn-icon" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="nx-hist" aria-label="Последние проверки">
        {Array.from({ length: 30 }, (_, i) => r.history[r.history.length - 30 + i]).map((d, i) => (
          <i key={i} className={d == null ? "" : d <= 0 ? "is-bad" : d > SLOW_MS ? "is-slow" : "is-ok"} style={d && d > 0 ? { height: `${Math.max(16, Math.min(100, (d / max) * 100))}%` } : undefined} />
        ))}
      </div>
      <small className="mh-muted">последние проверки · высота — задержка, красный — не ответил</small>
      <dl className="nx-dl">
        <dt>Состояние</dt>
        <dd>
          <Pill state={r.state} />
        </dd>
        <dt>Задержка</dt>
        <dd className="mono">{ms(r.delay)}</dd>
        {r.rate != null ? (
          <>
            <dt>Успешно</dt>
            <dd className="mono">{r.rate}%</dd>
          </>
        ) : null}
        <dt>Выход</dt>
        <dd>{r.country ? `${r.country} · проверено по факту` : "не проверялся"}</dd>
        <dt>Сервер</dt>
        <dd className="mono truncate">{r.meta?.server ? `${r.meta.server}${r.meta.port ? `:${r.meta.port}` : ""}` : "—"}</dd>
        <dt>SNI</dt>
        <dd className="mono truncate">{r.meta?.sni || "—"}</dd>
        <dt>Протокол</dt>
        <dd>{[r.meta?.type || r.type.toLowerCase(), r.meta?.network].filter(Boolean).join(" · ")}</dd>
      </dl>
      <div className="nx-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy === `t:${r.name}`} onClick={onTest}>
          <Icon name="bolt" size={13} /> {busy === `t:${r.name}` ? "Проверяю…" : "Проверить"}
        </button>
        {r.meta?.server ? (
          <button type="button" className="btn btn-sm" onClick={onServer}>
            Тот же сервер
          </button>
        ) : null}
      </div>
      {pinnable.length ? (
        <>
          <span className="vn-eyebrow">Закрепить в группе</span>
          <div className="vn-chips">
            {pinnable.map((g) => (
              <button key={g.name} type="button" className={`vn-chip${g.fixed === r.name ? " is-on" : ""}`} disabled={busy === `pin:${r.name}` || g.fixed === r.name} onClick={() => onPin(g.name)}>
                {g.fixed === r.name ? <Icon name="lock" size={12} /> : null}
                {g.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
