import { useCallback, useEffect, useMemo, useState } from "react";
import { core, mihomo, type Board, type BoardScan, type BoardServer, type BoardSource } from "../api";
import { OlcrtcPage, TailscalePage } from "../Proxies";
import { NodePanel, Strip } from "./NodePanel";
import { ago, hhmm } from "./VpnHome";
import "./servers.css";

/*
 * VPN → Серверы (NPM-71, canvas «HomeNet — редизайн», variant Г): a source
 * first — its state in one sentence and three numbers, the scan in progress,
 * lines the last update skipped; then how many servers worked by hour; then
 * the servers by state, opened into tiles with their last checks; a server's
 * history in a side panel. Subscriptions, checks and servers on one page.
 */

type State = "stable" | "flaky" | "down";
const STATE_TEXT: Record<State, [string, string]> = {
  stable: ["Надёжные", "Работают сейчас и обычно проходят проверки — на них трафик идёт в первую очередь."],
  flaky: ["С перебоями", "Работают сейчас, но часто не проходят проверки. Запас на крайний случай."],
  down: ["Не работают", ""],
};
const FAIL_TEXT: Record<string, string> = { silent: "не отвечают совсем", tls: "обрывается шифрование", reset: "сбрасывают соединение", http: "отвечает чужой сайт", body: "подменяют страницу", recovering: "прошли последнюю проверку, ждут ещё пары удачных подряд", nodata: "ещё не проверены в этом режиме", fail: "не прошли" };
const KIND_TEXT: Record<string, string> = { subscription: "подписка по ссылке", file: "файл на роутере", olcrtc: "свой сервер через видеозвонок", tailscale: "сеть домашних устройств" };
const PAGE = 24;

const stateOf = (r: BoardServer): State => (r.now !== "ok" ? "down" : r.stable ? "stable" : "flaky");
const short = (name: string) => name.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, "");

function useServersBoard() {
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setBoard(await core.board(7)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const running = !!board?.provider?.scan?.running;
  useEffect(() => {
    void load();
    // a scan in progress is followed closely; otherwise once a minute
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, running ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [load, running]);
  return { board, error, reload: load };
}

function minutes(ms: number) { const m = Math.max(1, Math.round(ms / 60000)); return `${m} мин`; }

function ScanProgress({ scan, last, onStop }: { scan: BoardScan; last?: BoardScan | null; onStop?: () => void }) {
  const total = Math.max(1, scan.planned);
  const pct = Math.min(100, Math.round(scan.done / total * 100));
  const elapsed = Date.now() - new Date(scan.startedAt).getTime();
  const lastLen = last && last.endedAt && !last.endedAt.startsWith("0001") ? new Date(last.endedAt).getTime() - new Date(last.startedAt).getTime() : 0;
  const eta = scan.done > 3 ? elapsed / scan.done * (total - scan.done) : lastLen ? lastLen - elapsed : 0;
  const step = scan.step === "control" ? "проверяю, что пускает провайдер" : scan.step === "confirm" ? "перепроверяю провайдера в конце" : `${scan.done} из ${scan.planned}`;
  return <section className="vs-scan" aria-label="Идёт проверка серверов">
    <div className="vs-scan-head"><b>Идёт проверка серверов · {step}</b><span>{eta > 0 ? `осталось около ${minutes(eta)}` : ""}{scan.rested ? ` · ${scan.rested} давно молчащих пропущены в этот раз` : ""}</span>{onStop && <span />}</div>
    <div className="vs-scan-bar" role="progressbar" aria-valuemin={0} aria-valuemax={scan.planned} aria-valuenow={scan.done} aria-label="Проверено серверов">
      <i className="vs-ok" style={{ width: `${scan.ok / total * 100}%` }} /><i className="vs-fail" style={{ width: `${scan.fail / total * 100}%` }} />
    </div>
    <div className="vs-scan-meta"><span><i className="vs-ok" /> работают: {scan.ok}</span><span><i className="vs-fail" /> не прошли: {scan.fail}</span><span>осталось: {Math.max(0, scan.planned - scan.done)}</span>{scan.probing?.length ? <span>сейчас: {scan.probing.slice(0, 4).map(short).join(", ")}</span> : null}</div>
    <span className="sr-only">Проверено {pct}%</span>
  </section>;
}

function Hours({ b }: { b: Board }) {
  const [week, setWeek] = useState(false);
  const [hover, setHover] = useState<number>();
  const list = (week ? b.hours_week : b.hours) || [];
  const max = Math.max(1, ...list.map(h => h.working));
  const day = list.filter(h => h.whitelist < 30).map(h => h.working);
  const wl = list.filter(h => h.whitelist >= 30).map(h => h.working);
  const range = (a: number[]) => (a.length ? `${Math.min(...a)}–${Math.max(...a)}` : "");
  const label = (t: number, i: number) => {
    const d = new Date(t * 1000);
    if (i === list.length - 1) return "сейчас";
    if (week) return d.getHours() === 0 ? d.toLocaleDateString("ru-RU", { weekday: "short" }) : "";
    return i % 3 === 0 ? `${String(d.getHours()).padStart(2, "0")}:00` : "";
  };
  return <section className="vs-block" aria-labelledby="vs-hours">
    <header className="vs-block-head"><h2 id="vs-hours">Сколько серверов работало</h2><span className="vs-muted">по часам · данные роутера</span><span className="vs-grow" />
      <div className="vs-seg" role="group" aria-label="Период"><button type="button" aria-pressed={!week} onClick={() => setWeek(false)}>Сутки</button><button type="button" aria-pressed={week} onClick={() => setWeek(true)}>Неделя</button></div></header>
    {list.length ? <figure className="vs-chart">
      <div className="vs-bars" data-dense={week ? "yes" : undefined} role="img" aria-label={`Работающие серверы по часам: ${list.map(h => h.working).join(", ")}`} onPointerLeave={() => setHover(undefined)}>
        {list.map((h, i) => <div key={h.t} className="vs-barslot" onPointerEnter={() => setHover(i)}><i data-wl={h.whitelist >= 30 ? "yes" : undefined} data-on={hover === i ? "yes" : undefined} style={{ height: `${Math.max(2, h.working / max * 100)}%` }} /></div>)}
        {hover !== undefined && <div className="vs-tip" style={{ left: `${Math.min(85, hover / list.length * 100)}%` }}>{new Date(list[hover].t * 1000).toLocaleString("ru-RU", { weekday: week ? "short" : undefined, hour: "2-digit", minute: "2-digit" })} — работало {list[hover].working}{list[hover].whitelist >= 30 ? " · белые списки" : ""}</div>}
      </div>
      <div className="vs-bar-labels" aria-hidden="true">{list.map((h, i) => <span key={h.t}>{label(h.t, i)}</span>)}</div>
      <figcaption className="vs-key">{day.length > 0 && <span><i className="vs-n" />обычный интернет — работало {range(day)}</span>}{wl.length > 0 && <span><i className="vs-wl" />белые списки — работало {range(wl)}</span>}</figcaption>
    </figure> : <p className="vs-muted">История копится — график появится через час.</p>}
  </section>;
}

function Tiles({ rows, onOpen, open }: { rows: BoardServer[]; onOpen: (name: string) => void; open?: string }) {
  const [limit, setLimit] = useState(PAGE);
  return <>
    <div className="vs-tiles">{rows.slice(0, limit).map(r => <button key={r.name} type="button" className="vs-tile" aria-pressed={open === r.name} onClick={() => onOpen(r.name)}>
      <span className="vs-tile-head"><b>{r.name}</b><span>{r.ms > 0 ? `${r.ms} мс` : ""}</span></span>
      <Strip hist={r.hist} />
      <span className="vs-tile-foot"><span>проходит {Math.round(r.rate * 100)}% проверок</span><span>{r.selected?.join(", ")}</span></span>
    </button>)}</div>
    {rows.length > limit && <button type="button" className="vs-more" onClick={() => setLimit(l => l + PAGE * 2)}>ещё {Math.min(PAGE * 2, rows.length - limit)} из {rows.length - limit}</button>}
  </>;
}

function AdaptiveSource({ b, src, navigate }: { b: Board; src: BoardSource; navigate: (p: string) => void }) {
  const [open, setOpen] = useState<State>("stable");
  const [panel, setPanel] = useState<string>();
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const mode = b.channel.mode === "whitelist" ? "whitelist" : "normal";
  const rows = b.servers?.rows[mode] || [];
  const byState = useMemo(() => {
    const m: Record<State, BoardServer[]> = { stable: [], flaky: [], down: [] };
    rows.forEach(r => m[stateOf(r)].push(r));
    // the ones that worked lately first among the silent
    m.down.sort((a, c) => (c.hist?.lastIndexOf("o") ?? -1) - (a.hist?.lastIndexOf("o") ?? -1) || c.rate - a.rate);
    return m;
  }, [rows]);
  const p = b.provider!;
  const fails = Object.entries(b.servers?.fails || {}).sort((a, c) => c[1] - a[1]);
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key); setNote("");
    try { await fn(); setNote(done); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  };
  const working = b.servers?.answering ?? 0;
  const stable = byState.stable.length;
  const sentence = b.channel.mode === "whitelist"
    ? `Сейчас провайдер пускает только на разрешённые сайты, и из подписки работает ${working < 30 ? "горстка серверов" : `${working} серверов`}. ${stable >= 3 ? "Обход держится" : stable ? "Обход держится, но запас маленький" : "Надёжных нет — обход может пропадать"}.`
    : b.channel.mode === "offline" ? "Провайдер сейчас не пускает в интернет — серверы недоступны, пока связь не вернётся."
      : `Интернет обычный: работает ${working} серверов из ${p.total}, надёжных — ${stable}.`;
  const wasStable = byState.down.find(r => r.stable);
  const names = (list: BoardServer[]) => list.slice(0, 3).map(r => short(r.name)).join(", ") + (list.length > 3 ? ` и ещё ${list.length - 3}` : "");
  return <>
    <section className="vs-hero" aria-labelledby="vs-name">
      <span className="vs-muted">{KIND_TEXT[src.kind]} · обновлена {p.updated_at ? hhmm(p.updated_at) : "—"} · {p.total} серверов{p.skipped?.length ? `, пропущено строк: ${p.skipped.length}` : ""}</span>
      <div className="vs-hero-row">
        <div className="vs-hero-text"><h1 id="vs-name">{p.name}</h1><p>{sentence}</p></div>
        <dl className="vs-numbers"><div><dt>в подписке</dt><dd>{p.total}</dd></div><div><dt>работают сейчас</dt><dd>{working}</dd></div><div><dt>надёжных</dt><dd className="vs-good">{stable}</dd></div></dl>
      </div>
      <div className="vs-actions">
        <button type="button" disabled={!!busy} onClick={() => void run("update", () => mihomo.updateProvider(p.name), "Подписка обновлена")}>{busy === "update" ? "Обновляю…" : "Обновить подписку"}</button>
        <button type="button" className="vs-primary" disabled={!!busy || !!p.scan?.running} onClick={() => void run("check", () => mihomo.healthcheck(p.name), "Проверка запущена")}>{p.scan?.running ? "Проверка идёт" : "Проверить серверы"}</button>
        {note && <span className="vs-muted" role="status">{note}</span>}
      </div>
      {p.skipped?.map(line => <div key={line} className="vs-warn"><i aria-hidden="true" />При обновлении пропущена строка {line.replace(/^\d+\s+/, "").replace(/: /, " — ")}. Остальные загружены.</div>)}
      {p.scan?.running ? <ScanProgress scan={p.scan} last={p.last_scan} /> : p.scan?.endedAt && !p.scan.endedAt.startsWith("0001") ? <p className="vs-muted">Последняя проверка всех серверов — {ago(p.scan.endedAt)}{p.scan.done ? `: прошли ${p.scan.ok} из ${p.scan.done}` : ""}. Следующую ядро запустит само.</p> : <p className="vs-muted">Последняя проверка всех серверов — {ago(p.checked_at)}. Следующую ядро запустит само.</p>}
    </section>

    <Hours b={b} />

    <section className="vs-block" aria-labelledby="vs-now">
      <header className="vs-block-head"><h2 id="vs-now">Серверы сейчас</h2><span className="vs-muted">{mode === "whitelist" ? "при белых списках" : "при обычном интернете"}</span></header>
      <div className="vs-states">
        {(["stable", "flaky", "down"] as State[]).map(s => <button key={s} type="button" className="vs-state" data-state={s} aria-expanded={open === s} onClick={() => setOpen(s)}>
          <span className="vs-state-n">{byState[s].length}</span><span className="vs-state-title">{STATE_TEXT[s][0]}</span>
          <span className="vs-state-text">{s === "down" ? fails.map(([k, v]) => `${v} — ${FAIL_TEXT[k] || k}`).join(", ") + "." : STATE_TEXT[s][1]}</span>
          <span className="vs-state-names">{s === "down" && wasStable ? `среди них ${short(wasStable.name)} — был надёжным` : names(byState[s])}</span>
        </button>)}
      </div>
      <div className="vs-open">
        <header className="vs-block-head"><b>{STATE_TEXT[open][0]} · {byState[open].length}</b><span className="vs-muted">полоска — последние проверки, слева старые</span></header>
        {byState[open].length ? <Tiles rows={byState[open]} onOpen={setPanel} open={panel} /> : <p className="vs-muted">Таких сейчас нет.</p>}
      </div>
    </section>
    {panel && <NodePanel name={panel} provider={p.name} onClose={() => setPanel(undefined)} navigate={navigate} />}
  </>;
}

export function ServersPage({ navigate, initial }: { navigate: (p: string) => void; initial?: string }) {
  const { board, error } = useServersBoard();
  const [pick, setPick] = useState(initial || "");
  if (!board) return <div className="vs">{error ? <div className="vs-warn" role="alert">Не удалось получить данные: {error}</div> : <p className="vs-muted" role="status">Собираю серверы…</p>}</div>;
  const sources = board.sources || [];
  const main = board.provider?.name || sources[0]?.name || "";
  const current = sources.find(s => s.name.toLowerCase() === pick.toLowerCase()) || sources.find(s => s.name === main) || sources[0];
  return <div className="vs">
    <div className="vs-top">
      <div className="vs-tabs" role="tablist" aria-label="Источник серверов">{sources.map(s => <button key={s.name} type="button" role="tab" aria-selected={current?.name === s.name} onClick={() => setPick(s.name)}>{s.name}<span>{s.alive}/{s.total}</span></button>)}</div>
      <a className="vs-add" href="#/coreconfig/providers">+ Источник</a>
    </div>
    {board.core_error && <div className="vs-warn" role="alert">{board.core_error}</div>}
    {!current ? <p className="vs-muted">Источников серверов нет — добавьте подписку.</p>
      : current.kind === "olcrtc" ? <OlcrtcPage embedded />
        : current.kind === "tailscale" ? <TailscalePage embedded />
          : current.name === board.provider?.name ? <AdaptiveSource b={board} src={current} navigate={navigate} />
            : <section className="vs-hero"><span className="vs-muted">{KIND_TEXT[current.kind]}{current.depends_on ? ` · проверяется через ${current.depends_on}` : ""}</span><h1>{current.name}</h1>
              <p>{current.depends_on ? `Каскады: те же серверы ${current.depends_on}, но через обход. Работает, когда работает ${current.depends_on}.` : "Ядро проверяет эти серверы обычной проверкой, без истории по режимам."}</p>
              <dl className="vs-numbers"><div><dt>серверов</dt><dd>{current.total}</dd></div><div><dt>работают</dt><dd>{current.alive}</dd></div></dl>
              {current.skipped?.map(line => <div key={line} className="vs-warn"><i aria-hidden="true" />Пропущена строка {line}</div>)}
              <a href="#/proxies">Узлы этого источника — в «Маршруты → Группы и узлы»</a></section>}
  </div>;
}
