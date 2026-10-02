import { useEffect, useMemo, useState } from "react";
import { PageHeader, type PageKey } from "../../navigation";
import { bytes, number } from "../../lib/format";
import { core, mihomo, type MProvider, type MProxy, type TrafficReport } from "./api";
import { MODE_LABEL, useMihomo } from "./context";
import { HealthHistory } from "./HealthHistory";
import { useTailscaleIssues } from "./Extras";
import { Alert } from "../../components/ui/controls";
import { Delay, lastDelay, speed } from "./shared";

/** «VPN → Обзор»: the state of mihomo at a glance (NPM-30). */
export function VpnOverview({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { status, configs, traffic } = useMihomo();
  const tsIssues = useTailscaleIssues(!!status?.controller_ok);
  const [proxies, setProxies] = useState<Record<string, MProxy>>({});
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [day, setDay] = useState<TrafficReport | null>(null);
  const [main, setMain] = useState("");
  const [last, setLast] = useState<{ working: number; total: number; stable: number; wl: number; mode: string } | null>(null);

  useEffect(() => {
    const pull = () => {
      void mihomo.allProxies().then((r) => {
        setProxies(r.proxies);
        setProviders(r.providers);
      }).catch(() => undefined);
      void core.traffic("24h").then(setDay).catch(() => setDay(null));
      void core.health("", "1h").then((r) => {
        setMain(r.provider);
        const p = r.series[r.series.length - 1];
        if (p) setLast({ working: p.working, total: p.total, stable: p.stable_normal, wl: p.stable_whitelist, mode: p.whitelist ? "белые списки" : p.offline ? "нет сети" : p.normal ? "без ограничений" : "не определён" });
      }).catch(() => undefined);
    };
    pull();
    const t = setInterval(() => document.visibilityState === "visible" && pull(), 30000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => {
    const order = proxies.GLOBAL?.all || [];
    return order.map((n) => proxies[n]).filter((p) => p && p.all && p.type !== "Compatible");
  }, [proxies]);
  const leaf = (name: string) => {
    let cur = proxies[name];
    for (let i = 0; cur && cur.now && i < 10; i++) cur = proxies[cur.now];
    return cur;
  };
  const subs = Object.values(providers).filter((p) => p.vehicleType !== "Compatible" && p.name !== "default");
  const now = traffic[traffic.length - 1];
  const go = (p: PageKey) => (e: React.MouseEvent) => {
    e.preventDefault();
    onNavigate(p);
  };

  return (
    <div className="stack">
      <PageHeader page="vpn" />
      {tsIssues.map((t) => (
        <Alert
          key={t.name}
          tone="danger"
          title={`${t.title} (${t.name})`}
          action={
            t.authURL ? (
              <a className="btn btn-sm btn-primary" href={t.authURL} target="_blank" rel="noopener noreferrer">
                Войти в tailnet
              </a>
            ) : (
              <a className="btn btn-sm" href="#/proxies/tailscale">
                Открыть Tailscale
              </a>
            )
          }
        >
          {t.text}
        </Alert>
      ))}
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Режим сети</span>
          <span className="stat-value">{last?.mode || "—"}</span>
          <span className="stat-meta">ядро в режиме «{configs ? MODE_LABEL[configs.mode] || configs.mode : "—"}»</span>
        </div>
        <div className="stat">
          <span className="stat-label">Рабочие узлы {main ? `· ${main}` : ""}</span>
          <span className="stat-value">{last ? `${last.working} / ${last.total}` : "—"}</span>
          <span className="stat-meta">{last ? `${last.stable} стабильных · ${last.wl} при белых списках` : "адаптивная проверка не включена"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Трафик за сутки</span>
          <span className="stat-value">↓ {bytes(day?.down)}</span>
          <span className="stat-meta">↑ {bytes(day?.up)} · сейчас ↓ {speed(now?.down)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Ядро</span>
          <span className="stat-value">{status?.version || "—"}</span>
          <span className="stat-meta">{status?.fork ? "форк x-happy-x" : "не форк"} · {status?.xkeen ? "XKeen" : "без XKeen"}</span>
        </div>
      </div>
      {main ? <HealthHistory provider={main} /> : null}
      <div className="grid-2 mh-grid-even">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Группы</h2>
            <a href="#/proxies" onClick={go("proxies")}>Все узлы →</a>
          </div>
          <div className="card-body mh-latency">
            {groups.slice(0, 10).map((g) => (
              <div key={g.name} className="mh-latency-row">
                <span className="truncate">
                  <strong>{g.name}</strong> <span className="cell-sub">→ {g.now || "—"}</span>
                </span>
                <Delay value={g.now ? lastDelay(leaf(g.now), g.testUrl) : null} />
              </div>
            ))}
            {!groups.length ? <p className="mh-muted">Нет групп.</p> : null}
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Подписки</h2>
            <a href="#/checks" onClick={go("checks")}>Проверка →</a>
          </div>
          <div className="card-body mh-subs">
            {subs.map((p) => {
              const i = p.subscriptionInfo;
              const used = i ? (i.Download || 0) + (i.Upload || 0) : 0;
              const total = i?.Total || 0;
              const alive = p.proxies.filter((x) => (lastDelay(x, p.testUrl) ?? 1) > 0).length;
              return (
                <div key={p.name} className="mh-sub-item">
                  <div className="mh-sub-row">
                    <strong>{p.name}</strong>
                    <span>
                      {number(p.proxies.length)} узлов · {number(alive)} отвечают
                      {total ? ` · ${bytes(used)} из ${bytes(total)}` : ""}
                      {i?.Expire ? ` · до ${new Date(i.Expire * 1000).toLocaleDateString("ru-RU")}` : ""}
                    </span>
                  </div>
                  {total ? (
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${Math.min(100, (used / total) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
