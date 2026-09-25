import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchDnsFinder, runDnsFinder, type DnsCheck, type DnsFinderPayload } from "../../api";
import { Icon } from "../../components/ui/Icon";
import { Alert } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { Tag, formatAgo, formatMs, type Tone } from "./shared";

// «DNS»: which resolvers work from here — directly through the operator and
// through mihomo — over plain DNS, DoT and DoH, how fast, and whether they
// answer honestly for blocked sites.

const TRANSPORTS: Array<["udp" | "dot" | "doh", string]> = [
  ["udp", "DNS"],
  ["dot", "DoT"],
  ["doh", "DoH"],
];
const PATHS: Array<["direct" | "mihomo", string]> = [
  ["direct", "Напрямую"],
  ["mihomo", "Через mihomo"],
];

const VERDICT: Record<DnsCheck["verdict"], { tone: Tone; label: string }> = {
  good: { tone: "good", label: "работает" },
  partial: { tone: "warning", label: "частично" },
  filtered: { tone: "critical", label: "подменяет" },
  proxyish: { tone: "info", label: "DNS-прокси" },
  down: { tone: "neutral", label: "нет ответа" },
};

function describe(c: DnsCheck) {
  const lines: string[] = [];
  if (c.error) lines.push(`Ошибка: ${c.error}`);
  if (c.spoofed.length) lines.push(`Подмена или блок: ${c.spoofed.join(", ")}`);
  if (c.proxied.length) lines.push(`Один и тот же адрес для разных сайтов (свой прокси): ${c.proxied.join(", ")}`);
  if (c.chain?.length) lines.push(`Маршрут mihomo: ${c.chain.join(" → ")}`);
  return lines.join("\n");
}

function viaText(c: DnsCheck) {
  if (c.path === "direct") return "";
  if (!c.chain?.length) return "";
  return c.chain[c.chain.length - 1] === "DIRECT" ? "mihomo: напрямую" : `через ${c.chain[c.chain.length - 1]}`;
}

function score(c: DnsCheck) {
  const base = { good: 0, partial: 3000, proxyish: 1500, filtered: 9000, down: 99999 }[c.verdict];
  return base + (c.ms || 0) + (c.transport === "udp" ? 200 : 0); // encrypted wins a tie
}

export function DnsFinder() {
  const [data, setData] = useState<DnsFinderPayload | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchDnsFinder());
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, data?.running ? 1500 : 15000);
    return () => clearInterval(timer);
  }, [load, data?.running]);

  const checks = data?.checks || [];
  const find = (provider: string, transport: string, path: string) => checks.find((c) => c.provider === provider && c.transport === transport && c.path === path);
  const best = (path: string) =>
    checks
      .filter((c) => c.path === path && c.ok && (c.verdict === "good" || c.verdict === "partial"))
      .sort((a, b) => score(a) - score(b))
      .slice(0, 3);
  const providerName = (id: string) => data?.providers.find((p) => p.id === id)?.name || id;
  const mihomoServers = data?.mihomo_servers || [];
  const current = mihomoServers.map((ip) => ({ ip, direct: checks.find((c) => c.transport === "udp" && c.path === "direct" && c.target === ip) }));

  return (
    <div className="net-stack">
      {error ? <Alert tone="danger" title="Ошибка">{error}</Alert> : null}
      <section className="card net-dns-head">
        <div>
          <h2>Поиск рабочего DNS</h2>
          <p className="muted">
            {data?.providers.length ?? 10} публичных резолверов, три способа (обычный DNS, DoT, DoH), напрямую через оператора и через mihomo. Каждому задаются {data?.domains.length ?? 5} домена:
            заблокированные, закрытые для России и российский — ответы сверяются с эталоном (Cloudflare DoH через VPN).
          </p>
        </div>
        <div className="net-dns-run">
          <button type="button" className="btn btn-primary" disabled={data?.running} onClick={() => void runDnsFinder().then(load).catch((e) => setError(errText(e)))}>
            {data?.running ? <span className="spinner" aria-hidden="true" /> : <Icon name="search" size={15} />}
            {data?.running ? `Проверяю ${data.progress} из ${data.total}` : "Проверить DNS"}
          </button>
          {data?.running ? (
            <span className="net-progress" aria-hidden="true">
              <i style={{ width: `${(data.progress / Math.max(1, data.total)) * 100}%` }} />
            </span>
          ) : (
            <small className="muted">{data?.finished ? `проверено ${formatAgo(data.finished)}` : "ещё не проверялось"} · около 1–2 минут</small>
          )}
        </div>
      </section>

      {checks.length ? (
        <>
          <div className="grid-2 net-grid">
            {PATHS.map(([path, label]) => {
              const list = best(path);
              return (
                <div key={path} className="card card-body net-dns-best">
                  <span className="net-reading-name">Лучшее — {label.toLowerCase()}</span>
                  {list.length === 0 ? (
                    <p>
                      <Tag tone="critical">ничего не работает</Tag>
                    </p>
                  ) : (
                    <ol>
                      {list.map((c) => (
                        <li key={c.provider + c.transport}>
                          <b>{providerName(c.provider)}</b> · {c.transport === "udp" ? "DNS" : c.transport.toUpperCase()} · {formatMs(c.ms)}
                          {viaText(c) ? <span className="muted"> · {viaText(c)}</span> : null}
                          <div className="mono muted net-dns-target">{c.transport === "udp" ? c.target : c.transport === "dot" ? `tls://${c.target}` : c.target}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>

          {mihomoServers.length ? (
            <Alert
              tone={current.some((x) => x.direct?.verdict === "filtered" || x.direct?.verdict === "down") ? "warning" : "info"}
              title="Сейчас mihomo спрашивает"
            >
              {current.map((x) => (
                <span key={x.ip} className="net-dns-current">
                  <span className="mono">{x.ip}</span> {x.direct ? <Tag tone={VERDICT[x.direct.verdict].tone}>{VERDICT[x.direct.verdict].label}</Tag> : <Tag tone="neutral">не проверялся</Tag>}
                </span>
              ))}
              <br />
              Обычным UDP напрямую через оператора. Если они не отвечают или подменяют ответы, лучше перевести mihomo на один из рабочих DoH выше.
            </Alert>
          ) : null}

          <div className="card table-wrap">
            <table className="table net-dns-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Резолвер</th>
                  {PATHS.map(([p, label]) => (
                    <th key={p} colSpan={3} className="net-dns-group">
                      {label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {PATHS.map(([p]) =>
                    TRANSPORTS.map(([t, label]) => (
                      <th key={p + t} className="net-dns-sub">
                        {label}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {(data?.providers || [])
                  .filter((p) => checks.some((c) => c.provider === p.id))
                  .map((p) => (
                    <Fragment key={p.id}>
                      <tr className="net-dns-row" onClick={() => setOpen(open === p.id ? null : p.id)}>
                        <td>
                          <div className="cell-title">
                            <Icon name={open === p.id ? "minus" : "plus"} size={12} /> {p.name}
                          </div>
                          {p.note ? <div className="cell-sub">{p.note}</div> : null}
                        </td>
                        {PATHS.map(([path]) =>
                          TRANSPORTS.map(([t]) => {
                            const c = find(p.id, t, path);
                            if (!c) return <td key={path + t} className="muted net-dns-cell">—</td>;
                            const v = VERDICT[c.verdict];
                            return (
                              <td key={path + t} className="net-dns-cell" title={describe(c)}>
                                <Tag tone={v.tone}>{c.ok ? formatMs(c.ms) : v.label}</Tag>
                                {c.ok && c.verdict !== "good" ? <small className={`net-dns-flag net-${v.tone}`}>{v.label}</small> : null}
                              </td>
                            );
                          }),
                        )}
                      </tr>
                      {open === p.id ? (
                        <tr className="net-dns-detail">
                          <td colSpan={7}>
                            <DetailTable checks={checks.filter((c) => c.provider === p.id)} domains={data?.domains || []} reference={data?.reference || {}} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="muted net-note">
            «Через mihomo» идёт по правилам: часть резолверов mihomo может пустить напрямую — маршрут видно в подсказке и в раскрытой строке. Обычный DNS через mihomo отправляется по TCP.
          </p>
        </>
      ) : null}
    </div>
  );
}

function DetailTable({ checks, domains, reference }: { checks: DnsCheck[]; domains: DnsFinderPayload["domains"]; reference: Record<string, string[]> }) {
  const kinds: Record<string, string> = { blocked: "заблокирован", geo: "закрыт для РФ", ru: "российский" };
  return (
    <div className="table-wrap">
      <table className="table net-dns-answers">
        <thead>
          <tr>
            <th>Способ</th>
            {domains.map((d) => (
              <th key={d.host} title={`Эталон: ${(reference[d.host] || []).join(", ")}`}>
                {d.host}
                <div className="cell-sub">{kinds[d.kind]}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.path + c.transport}>
              <td>
                {c.path === "direct" ? "напрямую" : "mihomo"} · {c.transport === "udp" ? "DNS" : c.transport.toUpperCase()}
                <div className="cell-sub mono">{c.target}</div>
                {c.chain?.length ? <div className="cell-sub">{c.chain.join(" → ")}</div> : null}
              </td>
              {domains.map((d) => {
                const a = c.answers?.[d.host];
                const bad = c.spoofed.includes(d.host);
                const prox = c.proxied.includes(d.host);
                return (
                  <td key={d.host} className={`mono net-dns-answer${bad ? " is-bad" : prox ? " is-proxy" : ""}`}>
                    {a || "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
