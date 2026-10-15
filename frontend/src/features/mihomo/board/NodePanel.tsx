import { useEffect, useRef, useState } from "react";
import { core, mihomo, type NodeDetail } from "../api";

/* NPM-71: a server's last checks as a strip, and the side panel with its history. */

const CODE_TEXT: Record<string, string> = { o: "открыл оба сайта", s: "не ответил за 5 секунд", t: "оборвалось шифрованное соединение", r: "соединение сбросили", h: "ответил чужой сайт", b: "страница подменена", f: "не прошёл" };
const NOW_TEXT: Record<string, string> = { ok: "Работает", silent: "Не работает · не отвечает", tls: "Не работает · обрыв шифрования", reset: "Не работает · сброс соединения", http: "Не работает · чужой ответ", body: "Не работает · подмена страницы", fail: "Не работает", recovering: "Возвращается · прошёл последнюю проверку", nodata: "Ещё не проверялся в этом режиме", skipped: "Не проверялся в этом режиме", unknown: "Ещё не проверялся" };
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** The last checks, oldest first: green passed, red failed, empty — not recorded yet. */
export function Strip({ hist, n = 24 }: { hist?: string; n?: number }) {
  const s = (hist || "").slice(-n);
  const pad = n - s.length;
  const passed = [...s].filter(c => c === "o").length;
  return <span className="vs-strip" role="img" aria-label={s.length ? `последние ${s.length} проверок: прошли ${passed}` : "история проверок ещё не записана"}>
    {Array.from({ length: pad }, (_, i) => <i key={`e${i}`} />)}
    {[...s].map((c, i) => <i key={i} data-c={c === "o" ? "ok" : "bad"} title={CODE_TEXT[c]} />)}
  </span>;
}

function Week({ week, base }: { week: string; base: number }) {
  // 168 hours ending at hour `base`; rows are local days
  const hours = [...week].map((c, i) => ({ c, t: (base - (week.length - 1 - i)) * 3600 }));
  const days: { label: string; cells: { c: string; h: number }[] }[] = [];
  hours.forEach(({ c, t }) => {
    const d = new Date(t * 1000);
    const key = d.toDateString();
    let row = days.find(x => x.label === key);
    if (!row) { row = { label: key, cells: [] }; days.push(row); }
    row.cells.push({ c, h: d.getHours() });
  });
  const today = new Date().toDateString();
  return <div className="vs-week" role="img" aria-label="Неделя по часам: зелёный — все проверки прошли, жёлтый — часть, красный — ни одной, пусто — не проверялся">
    {days.slice(-7).map(d => <div key={d.label} className="vs-week-row"><span>{d.label === today ? "сегодня" : WEEKDAY[new Date(d.label).getDay()]}</span>
      <span className="vs-week-cells">{Array.from({ length: 24 }, (_, h) => { const cell = d.cells.find(x => x.h === h); return <i key={h} data-c={cell?.c || "."} />; })}</span></div>)}
    <div className="vs-week-row vs-week-axis" aria-hidden="true"><span /><span className="vs-week-cells"><b>00</b><b>06</b><b>12</b><b>18</b><b>24</b></span></div>
  </div>;
}

export function NodePanel({ name, provider, onClose, navigate }: { name: string; provider: string; onClose: () => void; navigate: (p: string) => void }) {
  const [d, setD] = useState<NodeDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [pin, setPin] = useState("");
  const panel = useRef<HTMLElement>(null);
  const load = () => core.node(name, provider).then(setD).catch(e => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { setD(undefined); setError(""); setNote(""); void load(); }, [name, provider]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    panel.current?.focus();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const check = async () => {
    setBusy("check"); setNote("");
    try { const r = await core.nodeCheck(name); setNote(r.passed ? `Работает: ответил за ${r.ms} мс` : `Не работает: ${r.error}`); } catch (e) { setNote(String(e)); } finally { setBusy(""); }
  };
  const doPin = async () => {
    if (!pin) return;
    setBusy("pin"); setNote("");
    try { await mihomo.select(pin, name); setNote(`Группа «${pin}» теперь ведёт трафик через этот сервер`); await load(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  };
  const mode = d?.mode === "whitelist" ? "whitelist" : "normal";
  const rate = d?.modes[mode];
  const checks = [...(d?.history?.checks || [])].reverse().slice(0, 8);
  const leading = d?.groups.filter(g => g.leads) || [];
  const reserve = d?.groups.filter(g => !g.leads) || [];
  return <>
    <div className="vs-scrim" onClick={onClose} aria-hidden="true" />
    <aside ref={panel} tabIndex={-1} className="vs-panel" role="dialog" aria-modal="true" aria-labelledby="vs-panel-h">
      <header className="vs-panel-head">
        <div><span className="vs-muted">{provider}{d?.country ? ` · выходит в интернет: ${d.country}` : ""}</span><h2 id="vs-panel-h">{name}</h2>
          {d && <span className="vs-now" data-ok={d.now === "ok" ? "yes" : undefined}><i />{NOW_TEXT[d.now || "unknown"] || d.now}{rate?.stable ? " · надёжный" : ""}{rate?.ms ? ` · ${rate.ms} мс` : ""}</span>}</div>
        <button type="button" className="vs-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      {error && <div className="vs-warn" role="alert">{error}</div>}
      {!d && !error && <p className="vs-muted" role="status">Загружаю…</p>}
      {d && <>
        <section aria-labelledby="vs-p-rate"><h3 id="vs-p-rate">Как часто проходит проверку</h3>
          <div className="vs-pair">{(["whitelist", "normal"] as const).map(m => <div key={m}><b>{d.modes[m] ? `${Math.round(d.modes[m].rate * 100)}%` : "—"}</b><span>{m === "whitelist" ? "при белых списках" : "при обычном интернете"}{d.mode === m ? " — сейчас" : ""}</span>{d.modes[m] ? <small>{d.modes[m].checks.toLocaleString("ru-RU")} проверок{d.modes[m].ms ? ` · ${d.modes[m].ms} мс` : ""}</small> : null}</div>)}</div>
          <p className="vs-muted">Считается по последним проверкам, свежие весят больше. Надёжным сервер считается от 70% и если прошёл последнюю проверку.</p></section>
        <section aria-labelledby="vs-p-week"><h3 id="vs-p-week">История за неделю</h3>
          {d.history?.recorded ? <><Week week={d.history.week} base={d.history.base} /><div className="vs-key"><span><i data-c="g" />все проверки прошли</span><span><i data-c="y" />часть</span><span><i data-c="r" />ни одной</span><span><i data-c="." />не проверялся</span></div></>
            : <p className="vs-muted">HomeNet начал записывать историю этого сервера недавно — она появится после следующих проверок.</p>}</section>
        <section aria-labelledby="vs-p-last"><h3 id="vs-p-last">Последние проверки</h3>
          {checks.length ? <ul className="vs-checks">{checks.map(c => <li key={c.t}><i data-c={c.c === "o" ? "ok" : "bad"} /><span>{new Date(c.t * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span><span>{CODE_TEXT[c.c] || c.c}{c.ms ? ` за ${c.ms} мс` : ""}</span></li>)}</ul>
            : d.probes?.length ? <ul className="vs-checks">{d.probes.map(p => <li key={p.host}><i data-c={p.ok ? "ok" : "bad"} /><span>{p.host}</span><span>{p.ok ? `открылся за ${p.ms} мс` : p.fail || "не открылся"}</span></li>)}</ul> : <p className="vs-muted">Проверок ещё не было.</p>}</section>
        <section aria-labelledby="vs-p-use"><h3 id="vs-p-use">Кто его использует</h3>
          {d.groups.length ? <p>{leading.length ? <>Сейчас ведёт трафик {leading.map((g, i) => <span key={g.name}>{i ? ", " : ""}группы <b>{g.name}</b>{g.via ? ` (и через неё — ${g.via})` : ""}</span>)}. </> : "Сейчас трафик через него не идёт. "}
            {reserve.length ? <>Запасной в {reserve.slice(0, 4).map((g, i) => <span key={g.name}>{i ? ", " : ""}<b>{g.name}</b> — {g.place}-й из {g.of}</span>)}{reserve.length > 4 ? ` и ещё ${reserve.length - 4} группах` : ""}.</> : null}</p> : <p className="vs-muted">Ни одна группа его не использует.</p>}
          <button type="button" className="vs-link" onClick={() => navigate("vroute")}>Открыть маршруты</button></section>
        <footer className="vs-panel-foot">
          {note && <p role="status" className="vs-muted">{note}</p>}
          <div className="vs-actions">
            <button type="button" disabled={!!busy} onClick={() => void check()}>{busy === "check" ? "Проверяю…" : "Проверить сейчас"}</button>
            {reserve.length > 0 && <><label className="sr-only" htmlFor="vs-pin">Группа</label><select id="vs-pin" value={pin} onChange={e => setPin(e.target.value)}><option value="">Закрепить в группе…</option>{reserve.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}</select>
              <button type="button" className="vs-primary" disabled={!pin || !!busy} onClick={() => void doPin()}>Закрепить</button></>}
          </div>
        </footer>
      </>}
    </aside>
  </>;
}
