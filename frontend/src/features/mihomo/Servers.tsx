import { useEffect, useMemo, useState } from "react";
import { errText, number } from "../../lib/format";
import { core, type MProvider, type MProxy, type NodeMeta } from "./api";
import { lastDelay } from "./shared";
import type { NodePrefs } from "./NodeTiles";

/*
 * VPN → «Узлы» → «По серверам» (NPM-48). Nodes of one server fall together,
 * so the list goes by server: its address, subnet and the nodes on it, each
 * named by its TLS name (SNI) — the very thing a whitelist filter looks at.
 * Two nodes on one server with different SNI are not duplicates: one may pass
 * where the other is reset.
 */

type State = "ok" | "slow" | "silent" | "unknown";

const SLOW_MS = 800;

const FAIL: Record<string, string> = {
  silent: "молчит — похоже на отсев по IP",
  reset: "сброс соединения — похоже на отсев по SNI",
  tls: "ошибка TLS",
  http: "сайт ответил не тем",
  body: "ответ неполный",
};

function nodeState(p: MProvider, x: MProxy): { state: State; delay: number | null; note: string; country?: string } {
  const a = p.adaptive?.results?.[x.name];
  const d = lastDelay(x, p.testUrl);
  if (a && !a.skipped) {
    const country = a.country || (a.probes || []).find((pr) => pr.country)?.country;
    const fail = (a.probes || []).find((pr) => !pr.ok && pr.fail)?.fail;
    if (!a.available) return { state: "silent", delay: d, note: fail ? FAIL[fail] || fail : "не прошёл проверку подписки", country };
    return { state: d != null && d > SLOW_MS ? "slow" : "ok", delay: d, note: d ? `${d} мс` : "прошёл проверку", country };
  }
  if (d == null) return { state: "unknown", delay: null, note: "не проверялся" };
  if (d <= 0) return { state: "silent", delay: d, note: "нет ответа" };
  return { state: d > SLOW_MS ? "slow" : "ok", delay: d, note: `${d} мс` };
}

const subnet = (server: string) => {
  const m = server.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : "";
};

export function Servers({ providers, prefs }: { providers: MProvider[]; prefs: NodePrefs }) {
  const [meta, setMeta] = useState<Record<string, NodeMeta>>({});
  const [err, setErr] = useState("");
  const [provider, setProvider] = useState("");
  const [showSilent, setShowSilent] = useState(false);
  useEffect(() => {
    void core
      .nodes()
      .then((r) => setMeta(r.nodes))
      .catch((e) => setErr(errText(e)));
  }, []);

  const list = providers.filter((p) => p.proxies.length && p.vehicleType !== "Compatible");
  const current = list.find((p) => p.name === provider) || list.find((p) => p.name === "ROUTER") || list[0];

  const servers = useMemo(() => {
    if (!current) return [];
    const by = new Map<string, { server: string; port?: number; nodes: Array<{ x: MProxy; sni: string; st: ReturnType<typeof nodeState> }> }>();
    for (const x of current.proxies) {
      const m = meta[x.name];
      const key = m ? `${m.server}:${m.port || ""}` : "?";
      if (!by.has(key)) by.set(key, { server: m?.server || "адрес неизвестен", port: m?.port, nodes: [] });
      by.get(key)!.nodes.push({ x, sni: m?.sni || "", st: nodeState(current, x) });
    }
    const rows = [...by.values()].map((s) => {
      const alive = s.nodes.filter((n) => n.st.state === "ok" || n.st.state === "slow");
      const delays = alive.map((n) => n.st.delay || 0).filter((d) => d > 0);
      return { ...s, alive: alive.length, best: delays.length ? Math.min(...delays) : 0 };
    });
    rows.sort((a, b) => b.alive / b.nodes.length - a.alive / a.nodes.length || (a.best || 1e9) - (b.best || 1e9));
    return rows;
  }, [current, meta]);

  const silentServers = servers.filter((s) => !s.alive);
  const shown = prefs.hideDead && !showSilent ? servers.filter((s) => s.alive) : servers;

  return (
    <div className="stack">
      {list.length > 1 ? (
        <div className="vn-chips" role="group" aria-label="Подписка">
          {list.map((p) => (
            <button key={p.name} className={`vn-chip${current?.name === p.name ? " is-on" : ""}`} aria-pressed={current?.name === p.name} onClick={() => setProvider(p.name)}>
              {p.name} · {number(p.proxies.length)}
            </button>
          ))}
        </div>
      ) : null}
      {err ? <p className="vn-err">{err}</p> : null}
      <div className="vs-legend">
        <span>
          <i className="vs-dot vs-ok" />
          отвечает
        </span>
        <span>
          <i className="vs-dot vs-slow" />
          медленнее {SLOW_MS} мс
        </span>
        <span>
          <i className="vs-dot vs-silent" />
          молчит или не прошёл проверку
        </span>
        <span className="mh-muted">Узлы одного сервера с разным SNI — не дубли: фильтр может пропустить одно имя и сбросить другое.</span>
      </div>
      <div className="vs-list">
        {shown.map((s) => {
          const tone = !s.alive ? "bad" : s.alive < s.nodes.length ? "warn" : "ok";
          const nodes = prefs.hideDead ? s.nodes.filter((n) => n.st.state !== "silent") : s.nodes;
          return (
            <section key={`${s.server}:${s.port}`} className={`vs-server${tone === "bad" ? " is-bad" : ""}`}>
              <header>
                <span className="vs-title">
                  <b className="mono">
                    {s.server}
                    {s.port && s.port !== 443 ? `:${s.port}` : ""}
                  </b>
                  <small>
                    {[subnet(s.server) ? `подсеть ${subnet(s.server)}` : "", `${s.nodes.length} ${s.nodes.length === 1 ? "узел" : s.nodes.length < 5 ? "узла" : "узлов"}`].filter(Boolean).join(" · ")}
                  </small>
                </span>
                <span className={`vn-pill vn-${tone}`}>{!s.alive ? "молчит" : `${s.alive} из ${s.nodes.length}${s.best ? ` · ${s.best} мс` : ""}`}</span>
              </header>
              <div className="vs-nodes">
                {nodes.map((n) => (
                  <span key={n.x.name} className={`vs-node vs-${n.st.state}`} title={n.x.name}>
                    <i className={`vs-dot vs-${n.st.state}`} />
                    <span>
                      <span className="mono">{n.sni || n.x.name}</span>
                      <small>
                        {n.sni ? `${n.x.name} · ` : ""}
                        {n.st.country ? `выход ${n.st.country} · ` : ""}
                        {n.st.note}
                      </small>
                    </span>
                  </span>
                ))}
                {prefs.hideDead && nodes.length < s.nodes.length ? <span className="mh-muted vs-more">+{s.nodes.length - nodes.length} молчат</span> : null}
              </div>
            </section>
          );
        })}
        {prefs.hideDead && silentServers.length ? (
          <button className="btn btn-sm vs-show" onClick={() => setShowSilent(!showSilent)}>
            {showSilent ? "Скрыть молчащие серверы" : `Показать ${silentServers.length} молчащих серверов`}
          </button>
        ) : null}
        {!servers.length ? <p className="mh-muted">В подписке нет узлов.</p> : null}
      </div>
    </div>
  );
}
