import { Fragment, useEffect, useState } from "react";
import { analyzeTarget, type Analysis, type ProbePath, type ProbeStep } from "../../api";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Alert } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { ANALYSIS_VERDICT, PATH_TITLES, STAGES, StepIcon, Tag, formatClock, formatMs, pathVerdict, stepTone, type Tone } from "./shared";

// «Анализатор»: one site, checked stage by stage over three paths, drawn as
// the network pipeline with the step where it breaks.

const PATHS: Array<{ id: string; label: string; hint: string }> = [
  { id: "direct", label: "Netcraze напрямую", hint: "мимо mihomo — так сайт видит ТСПУ" },
  { id: "mihomo", label: "Через mihomo", hint: "как у клиентов LAN, по правилам" },
  { id: "mikrotik", label: "MikroTik", hint: "ping и fetch с самого MikroTik, DNS оператора" },
];

const EXAMPLES = ["youtube.com", "rutracker.org", "chatgpt.com", "gosuslugi.ru", "hetzner.com", "speed.cloudflare.com/__down?bytes=200000"];

export function NetworkAnalyzer({ result, onResult, initialTarget }: { result: Analysis | null; onResult: (a: Analysis) => void; initialTarget?: string }) {
  const [target, setTarget] = useState(initialTarget || result?.target || "");
  const [paths, setPaths] = useState<string[]>(["direct", "mihomo", "mikrotik"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<Analysis[]>([]);

  const run = async (value = target) => {
    if (!value.trim() || busy) return;
    setTarget(value);
    setBusy(true);
    setError("");
    try {
      const res = await analyzeTarget(value.trim(), paths);
      onResult(res);
      setRecent((list) => [res, ...list.filter((r) => r.target !== res.target)].slice(0, 8));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialTarget) void run(initialTarget);
    // Only the hand-over value starts a run; later edits are manual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTarget]);

  return (
    <div className="net-stack">
      <form
        className="card net-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="net-form-row">
          <label className="field net-form-target">
            <span className="field-label">Сайт или адрес</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="youtube.com или https://site.com/путь" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !target.trim() || paths.length === 0}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="search" size={15} />}
            {busy ? "Проверяю…" : "Проверить"}
          </button>
        </div>
        <div className="net-form-row net-form-paths">
          {PATHS.map((p) => (
            <label key={p.id} className="net-check-label">
              <input
                type="checkbox"
                checked={paths.includes(p.id)}
                onChange={(e) => setPaths((list) => (e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)))}
              />
              <span>
                <b>{p.label}</b>
                <small>{p.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="chip-list net-examples">
          <span className="muted">Примеры:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip" onClick={() => void run(ex)} disabled={busy}>
              {ex.replace(/\/.*$/, "")}
            </button>
          ))}
        </div>
        {busy ? <p className="muted">Проверка занимает до 30 секунд: на заблокированных шагах приходится ждать таймаут.</p> : null}
      </form>
      {error ? <Alert tone="danger" title="Проверка не удалась">{error}</Alert> : null}
      {result ? <AnalysisView result={result} /> : null}
      {recent.length > 1 ? (
        <div className="net-recent">
          <span className="muted">Недавние:</span>
          {recent.map((r) => (
            <button key={r.target} type="button" className="chip" onClick={() => onResult(r)}>
              <Tag tone={ANALYSIS_VERDICT[r.verdict].tone}>{r.host}</Tag>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AnalysisView({ result }: { result: Analysis }) {
  const verdict = ANALYSIS_VERDICT[result.verdict] || { tone: "neutral" as Tone, label: result.verdict };
  const clients =
    result.clients.via === "ipset"
      ? `напрямую: IP в списке ${result.clients.ipset}, mihomo их не видит`
      : result.clients.via === "mihomo"
        ? `${result.clients.direct ? "напрямую" : "через прокси"} — правило ${result.clients.rule || "?"}${result.clients.chain?.length ? `, ${result.clients.chain.join(" → ")}` : ""}`
        : "неизвестно (mihomo не проверялся)";
  return (
    <div className="net-stack">
      <div className={`card net-verdict net-verdict-${verdict.tone}`}>
        <div className="net-verdict-main">
          <Tag tone={verdict.tone}>{verdict.label}</Tag>
          <h2>{result.host}</h2>
          <p>{result.summary}</p>
        </div>
        <dl className="net-verdict-facts">
          <div>
            <dt>Клиенты LAN идут</dt>
            <dd>{clients}</dd>
          </div>
          <div>
            <dt>IP для проверки</dt>
            <dd className="mono">{result.ip || "—"}</dd>
          </div>
          <div>
            <dt>Проверено</dt>
            <dd>
              {formatClock(result.at)} · {formatMs(result.ms)}
            </dd>
          </div>
        </dl>
      </div>
      {result.hints.map((h) => (
        <Alert key={h} tone="warning" title="Что стоит сделать">
          {h}
        </Alert>
      ))}

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>Путь запроса</h2>
            <p>Крестик — шаг, на котором запрос не прошёл. Наведите на шаг, чтобы увидеть подробности.</p>
          </div>
        </header>
        <div className="net-lanes">
          {result.paths.map((p) => (
            <Lane key={p.id} path={p} result={result} />
          ))}
        </div>
      </section>

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>Шаги</h2>
          </div>
        </header>
        <div className="card table-wrap">
          <table className="table net-matrix">
            <thead>
              <tr>
                <th>Путь</th>
                {STAGES.map((s) => (
                  <th key={s.id} title={s.hint}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.paths.map((p) => {
                const v = pathVerdict(p.verdict);
                return (
                  <Fragment key={p.id}>
                    <tr>
                      <td>
                        <div className="cell-title">{p.title}</div>
                        <Tag tone={v.tone}>{v.label}</Tag>
                      </td>
                      {STAGES.map((s) => {
                        const step = p.steps.find((x) => x.id === s.id);
                        return (
                          <td key={s.id} className={`net-cell net-cell-${step ? stepTone(step.status) : "neutral"}`}>
                            {step ? (
                              <>
                                <StepIcon status={step.status} />
                                <span className="net-cell-text">{step.detail || (step.status === "ok" ? "ок" : step.status === "skip" ? "не проверялось" : "")}</span>
                                {step.ms ? <span className="net-cell-ms">{formatMs(step.ms)}</span> : null}
                              </>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    <tr className="net-matrix-summary">
                      <td colSpan={STAGES.length + 1}>{p.summary}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>DNS</h2>
            <p>Эталон — зашифрованный DoH: его ни оператор, ни ТСПУ подменить не могут.</p>
          </div>
        </header>
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Резолвер</th>
                <th>Ответ</th>
                <th>Оценка</th>
                <th>Время</th>
              </tr>
            </thead>
            <tbody>
              {result.dns.map((d) => {
                const tone: Tone = d.verdict === "reference" || d.verdict === "ok" ? "good" : d.verdict === "differs" ? "neutral" : "critical";
                const label = { reference: "эталон", ok: "совпадает", differs: "другие IP (CDN)", empty: "пусто", bogus: "подмена", error: "ошибка" }[d.verdict] || d.verdict;
                return (
                  <tr key={d.id}>
                    <td>
                      <div className="cell-title">{d.resolver}</div>
                      <div className="cell-sub">{d.via}</div>
                    </td>
                    <td className="mono net-dns-ips">{d.ips.length ? d.ips.join(", ") : d.error || d.rcode || "—"}</td>
                    <td>
                      <Tag tone={tone}>{label}</Tag>
                    </td>
                    <td>{formatMs(d.ms)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

type Node = { key: string; icon: IconName; title: string; sub?: string; stages?: string[] };

// Each lane is the physical path of that probe; stages are pinned to the hop
// they happen on, so a failure lands on the right box.
function laneNodes(path: ProbePath, result: Analysis): Node[] {
  const host: Node = { key: "host", icon: "globe", title: result.host, sub: result.ip || "", stages: ["tcp", "tls", "http", "bulk"] };
  if (path.id === "direct") {
    return [
      { key: "nc", icon: "route", title: "Netcraze", sub: "метка 255, мимо mihomo" },
      { key: "dns", icon: "dns", title: "DNS 77.88.8.8", sub: "UDP через оператора", stages: ["dns"] },
      { key: "mt", icon: "activity", title: "MikroTik", sub: "LTE" },
      { key: "tspu", icon: "lock", title: "ТСПУ оператора", sub: "видит SNI и IP" },
      host,
    ];
  }
  if (path.id === "mikrotik") {
    return [
      { key: "mt", icon: "activity", title: "MikroTik", sub: "/tool/fetch" },
      { key: "dns", icon: "dns", title: "DNS оператора", sub: "как у MikroTik", stages: ["dns"] },
      { key: "tspu", icon: "lock", title: "ТСПУ оператора", sub: "видит SNI и IP" },
      host,
    ];
  }
  const chain = path.chain || [];
  const direct = chain.length > 0 && chain[chain.length - 1] === "DIRECT";
  const nodes: Node[] = [
    { key: "nc", icon: "route", title: "Netcraze", sub: "SOCKS mihomo" },
    { key: "rule", icon: "bolt", title: "mihomo", sub: path.rule || "правило не найдено", stages: ["dns"] },
  ];
  if (direct) {
    nodes.push({ key: "grp", icon: "layers", title: chain.slice(0, -1).join(" → ") || "DIRECT", sub: "напрямую" });
    nodes.push({ key: "mt", icon: "activity", title: "MikroTik", sub: "LTE" });
    nodes.push({ key: "tspu", icon: "lock", title: "ТСПУ оператора", sub: "видит SNI и IP" });
  } else {
    nodes.push({ key: "grp", icon: "layers", title: chain.slice(0, -1).join(" → ") || "группа", sub: "выбор узла" });
    nodes.push({ key: "tspu", icon: "lock", title: "MikroTik · ТСПУ", sub: "видят только туннель" });
    nodes.push({ key: "vpn", icon: "external", title: chain[chain.length - 1] || "VPN-узел", sub: "выход в интернет" });
  }
  nodes.push(host);
  return nodes;
}

function Lane({ path, result }: { path: ProbePath; result: Analysis }) {
  const v = pathVerdict(path.verdict);
  const nodes = laneNodes(path, result);
  // Each failed step is drawn on the hop where it happens: DNS on the
  // resolver, the rest at the last hop before the site (the operator's ТСПУ
  // on direct paths, the proxy node for mihomo).
  const has = (key: string) => nodes.some((n) => n.key === key);
  const nodeFor = (step: ProbeStep) => {
    if (step.id === "dns") return has("dns") ? "dns" : "rule";
    if (path.id === "mihomo" && step.id === "tcp") return has("vpn") ? "vpn" : "rule";
    return has("tspu") ? "tspu" : "host";
  };
  const fails = new Map<string, ProbeStep[]>();
  for (const step of path.steps) {
    if (step.status !== "fail") continue;
    const key = nodeFor(step);
    fails.set(key, [...(fails.get(key) || []), step]);
  }
  const lastFail = Math.max(-1, ...nodes.map((n, i) => (fails.has(n.key) ? i : -1)));
  return (
    <div className={`card net-lane net-lane-${v.tone}`}>
      <div className="net-lane-head">
        <b>{PATH_TITLES[path.id] || path.title}</b>
        <Tag tone={v.tone}>{v.label}</Tag>
        <span className="muted net-lane-summary">{path.summary}</span>
      </div>
      <ol className="net-flow">
        {nodes.map((n, i) => {
          const failed = fails.get(n.key);
          const passed = lastFail < 0 || i < lastFail;
          const stages = (n.stages || []).map((id) => path.steps.find((s) => s.id === id)).filter((s): s is ProbeStep => !!s);
          return (
            <li key={n.key} className={`net-node${failed ? " is-fail" : passed ? " is-pass" : " is-after"}`}>
              <div className="net-node-box" title={n.sub}>
                <span className="net-node-icon">
                  <Icon name={failed ? "error" : n.icon} size={15} />
                </span>
                <span className="net-node-text">
                  <b>{n.title}</b>
                  {n.sub ? <small>{n.sub}</small> : null}
                </span>
              </div>
              {failed?.map((f) => (
                <div key={f.id} className="net-node-fail">
                  {f.title}: {f.detail}
                </div>
              ))}
              {stages.length ? (
                <div className="net-node-stages">
                  {stages.map((s) => (
                    <span key={s.id} className={`net-stage-chip net-${stepTone(s.status)}`} title={`${s.title}${s.detail ? ": " + s.detail : ""}`}>
                      <StepIcon status={s.status} />
                      {STAGES.find((x) => x.id === s.id)?.label || s.title}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
