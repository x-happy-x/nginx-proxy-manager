import { useEffect, useMemo, useState } from "react";
import { bytes, errText, number } from "../../lib/format";
import { core, type CoreDevice, type TrafficReport } from "./api";

/*
 * «Что открывают чаще» (NPM-49): sites and devices side by side. A click on a
 * site shows who opens it, a click on a device shows what it opens; any site
 * can be added to the services checked on «Сейчас».
 */

type Period = "24h" | "7d" | "30d";
type Metric = "count" | "bytes";
type Row = { key: string; count: number; bytes: number };

/** A device's connections to its own network, the router and DNS servers. */
const OTHER = "локальная сеть и DNS";

const PERIODS: Array<[Period, string]> = [
  ["24h", "Сутки"],
  ["7d", "7 дней"],
  ["30d", "30 дней"],
];

// addresses that are not sites people open: the router, local networks and
// the public DNS servers devices ask (their queries are answered by mihomo)
const RESOLVERS = new Set(["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "77.88.8.8", "77.88.8.1", "77.88.8.2", "77.88.8.88", "208.67.222.222", "208.67.220.220", "dns.google", "one.one", "cloudflare-dns.com"]);
const isNoise = (site: string) =>
  !site || site === "—" || RESOLVERS.has(site) || /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(site) || /^(fe80|ff0|224\.|239\.)/.test(site) || /\.local$/.test(site);
const isIP = (site: string) => /^\d+\.\d+\.\d+\.\d+$/.test(site) || site.includes(":");

export function Usage({ known, onAdd }: { known: Set<string>; onAdd: (site: string) => Promise<void> }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [metric, setMetric] = useState<Metric>("count");
  const [rep, setRep] = useState<TrafficReport | null>(null);
  const [devices, setDevices] = useState<CoreDevice[]>([]);
  const [site, setSite] = useState("");
  const [device, setDevice] = useState("");
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState("");
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    void core
      .traffic(period)
      .then((r) => alive && setRep(r))
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [period]);
  useEffect(() => {
    void core
      .devices()
      .then((r) => setDevices(r.devices))
      .catch(() => undefined);
  }, []);

  const nameOf = useMemo(() => {
    const m = new Map(devices.map((d) => [d.ip, d.name || d.hostname || d.ip]));
    // no source address: the router's own requests (mihomo, checks, updates)
    return (ip: string) => (ip ? m.get(ip) || ip : "роутер и mihomo");
  }, [devices]);

  const val = (r: Row) => (metric === "count" ? r.count : r.bytes);
  const fmt = (n: number) => (metric === "count" ? `${number(n)}` : bytes(n));

  // every site × device pair, the local and DNS ones too: a device's total is
  // the sum of its pairs, so the two columns add up once one is picked
  const allPairs = useMemo(
    () =>
      (rep?.dims.site_device || []).map((r) => {
        const i = r.key.lastIndexOf("|");
        return { site: r.key.slice(0, i), device: r.key.slice(i + 1), count: r.count, bytes: r.up + r.down };
      }),
    [rep],
  );
  const hasPairs = allPairs.length > 0;
  const picked = !!(site || device) && hasPairs;
  const sum = (list: typeof allPairs, keyOf: (p: (typeof allPairs)[number]) => string) => {
    const m = new Map<string, Row>();
    list.forEach((p) => {
      const k = keyOf(p);
      const r = m.get(k) || { key: k, count: 0, bytes: 0 };
      r.count += p.count;
      r.bytes += p.bytes;
      m.set(k, r);
    });
    return [...m.values()];
  };

  const sites: Row[] = useMemo(() => {
    if (picked) {
      const mine = device ? allPairs.filter((p) => p.device === device) : allPairs;
      const rows = sum(
        mine.filter((p) => !isNoise(p.site)),
        (p) => p.site,
      );
      const other = mine.filter((p) => isNoise(p.site));
      if (device && other.length) rows.push({ key: OTHER, count: other.reduce((a, p) => a + p.count, 0), bytes: other.reduce((a, p) => a + p.bytes, 0) });
      return rows;
    }
    return (rep?.dims.site || []).filter((r) => !isNoise(r.key)).map((r) => ({ key: r.key, count: r.count, bytes: r.up + r.down }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, allPairs, device, picked]);
  const devs: Row[] = useMemo(() => {
    if (picked)
      return sum(
        site ? allPairs.filter((p) => p.site === site) : allPairs,
        (p) => p.device,
      ).filter((r) => !r.key.startsWith("fe80") && r.key !== "127.0.0.1");
    return (rep?.dims.device || []).filter((r) => !r.key.startsWith("fe80") && r.key !== "127.0.0.1").map((r) => ({ key: r.key, count: r.count, bytes: r.up + r.down }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, allPairs, site, picked]);
  const pairsSince = rep?.dims_since?.site_device || 0;
  const periodStart = rep ? Date.now() / 1000 - { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 }[period] : 0;
  const partial = picked && pairsSince > periodStart + 3600;

  const sortedSites = [...sites].sort((a, b) => val(b) - val(a));
  const sortedDevs = [...devs].sort((a, b) => val(b) - val(a));
  const maxSite = Math.max(1, ...sortedSites.map(val));
  const maxDev = Math.max(1, ...sortedDevs.map(val));
  const shownSites = sortedSites.slice(0, more ? 60 : 15);

  return (
    <section className="vu" aria-label="Что открывают чаще">
      <div className="vn-section-head">
        <h3>
          Что открывают чаще <span>· нажмите на сайт или устройство</span>
        </h3>
        <div className="vu-controls">
          <div className="vn-chips" role="group" aria-label="Период">
            {PERIODS.map(([p, label]) => (
              <button key={p} className={`vn-chip${period === p ? " is-on" : ""}`} aria-pressed={period === p} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>
          <div className="vn-chips" role="group" aria-label="Мера">
            <button className={`vn-chip${metric === "count" ? " is-on" : ""}`} aria-pressed={metric === "count"} onClick={() => setMetric("count")}>
              Соединения
            </button>
            <button className={`vn-chip${metric === "bytes" ? " is-on" : ""}`} aria-pressed={metric === "bytes"} onClick={() => setMetric("bytes")}>
              Трафик
            </button>
          </div>
        </div>
      </div>
      {err ? <p className="vn-err">{err}</p> : null}
      {(site || device) && !hasPairs ? <p className="mh-muted">Связь «сайт — устройство» ещё не накоплена за этот период.</p> : null}
      {partial ? (
        <p className="mh-muted">
          Кто что открывает, HomeNet считает с {new Date(pairsSince * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}: пока выбран сайт или
          устройство, обе колонки показывают это время, а не весь период.
        </p>
      ) : null}
      <div className="vu-grid">
        <div className="vu-col">
          <div className="vu-col-head">
            <b>{device ? `Сайты · ${nameOf(device)}` : "Сайты"}</b>
            {device ? (
              <button className="btn btn-sm" onClick={() => setDevice("")}>
                Все устройства
              </button>
            ) : null}
          </div>
          {shownSites.map((r) => (
            <div key={r.key} className={`vu-row${site === r.key ? " is-on" : ""}`}>
              <button className="vu-main" aria-pressed={site === r.key} disabled={r.key === OTHER} onClick={() => setSite(site === r.key ? "" : r.key)}>
                <span className="vu-name">{r.key}</span>
                <span className="vu-bar">
                  <i style={{ width: `${(val(r) / maxSite) * 100}%` }} />
                </span>
                <span className="vu-val">{fmt(val(r))}</span>
              </button>
              {r.key === OTHER ? (
                <span className="vu-known" title="Роутер, устройства дома и DNS-серверы">
                  не сайты
                </span>
              ) : isIP(r.key) ? (
                <span className="vu-known" title="Адрес без имени: проверять как сервис нечего">
                  IP-адрес
                </span>
              ) : known.has(r.key) ? (
                <span className="vu-known" title="Уже проверяется на «Сейчас»">
                  в сервисах
                </span>
              ) : (
                <button
                  className="btn btn-sm vu-add"
                  disabled={adding === r.key}
                  onClick={async () => {
                    setAdding(r.key);
                    try {
                      await onAdd(r.key);
                    } catch (e) {
                      setErr(errText(e));
                    } finally {
                      setAdding("");
                    }
                  }}
                  aria-label={`Добавить ${r.key} в сервисы`}
                >
                  + в сервисы
                </button>
              )}
            </div>
          ))}
          {sortedSites.length > 15 ? (
            <button className="btn btn-sm" onClick={() => setMore(!more)}>
              {more ? "Свернуть" : `Ещё ${Math.min(45, sortedSites.length - 15)}`}
            </button>
          ) : null}
          {!sortedSites.length ? <p className="mh-muted">{rep ? "Нет данных за этот период." : "Загружаю…"}</p> : null}
        </div>
        <div className="vu-col">
          <div className="vu-col-head">
            <b>{site ? `Устройства · ${site}` : "Устройства"}</b>
            {site ? (
              <button className="btn btn-sm" onClick={() => setSite("")}>
                Все сайты
              </button>
            ) : null}
          </div>
          {sortedDevs.slice(0, 20).map((r) => (
            <div key={r.key} className={`vu-row${device === r.key ? " is-on" : ""}`}>
              <button className="vu-main" aria-pressed={device === r.key} onClick={() => setDevice(device === r.key ? "" : r.key)}>
                <span className="vu-name">
                  {nameOf(r.key)}
                  {nameOf(r.key) !== r.key ? <small> {r.key}</small> : null}
                </span>
                <span className="vu-bar">
                  <i style={{ width: `${(val(r) / maxDev) * 100}%` }} />
                </span>
                <span className="vu-val">{fmt(val(r))}</span>
              </button>
            </div>
          ))}
          {!sortedDevs.length ? <p className="mh-muted">{rep ? "Нет данных." : "Загружаю…"}</p> : null}
        </div>
      </div>
    </section>
  );
}
