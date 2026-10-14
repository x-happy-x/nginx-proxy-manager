import { useMemo, useState } from "react";
import type { BoardServer } from "../api";
import { pct, useBoard, ago } from "./VpnHome";
import "./board.css";

/*
 * VPN → Серверы (NPM-70, макет «Какие серверы надёжны и насколько»). Доля
 * удачных проверок и задержка — из рейтингов ядра, отдельно для белых списков
 * и для обычного интернета: сервер, хороший в одном режиме, бывает бесполезен
 * в другом. «Сейчас» — последний обход, с причиной молчания.
 */

const NOW_TEXT: Record<string, string> = { ok: "отвечает", silent: "молчит · тишина", tls: "молчит · TLS", reset: "молчит · сброс", http: "чужой ответ", body: "чужая страница", fail: "не прошёл", skipped: "не проверялся", unknown: "нет данных" };
const MODES = [["whitelist", "При белых списках"], ["normal", "При обычном интернете"]] as const;
const PAGE = 60;

function rateTone(r: number) { return r >= 0.8 ? "ok" : r >= 0.5 ? "warn" : "bad"; }
function tag(r: BoardServer) { return r.stable ? "надёжный" : r.checks < 3 ? "мало проверок" : "ненадёжный"; }

export function VpnServers() {
  const { board, error } = useBoard();
  const [mode, setMode] = useState<"whitelist" | "normal">();
  const [onlyGood, setOnlyGood] = useState(true);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const current = mode || (board?.channel.mode === "normal" ? "normal" : "whitelist");
  const rows = useMemo(() => {
    const list = board?.servers?.rows[current] || [];
    const q = query.trim().toLowerCase();
    return list.filter(r => (!onlyGood || (r.stable || r.now === "ok")) && (!q || r.name.toLowerCase().includes(q) || r.selected?.some(g => g.toLowerCase().includes(q))));
  }, [board, current, onlyGood, query]);
  if (!board) return <div className="vb">{error ? <div className="vb-alert" role="alert">Не удалось получить данные: {error}</div> : <p className="vb-muted" role="status">Загружаю рейтинги серверов…</p>}</div>;
  const s = board.servers;
  if (!s || !board.provider) return <div className="vb"><h1>Серверы</h1><div className="vb-alert">{board.core_error || "В ядре нет подписки с adaptive-проверкой — рейтингов нет."}</div></div>;
  const fails = Object.entries(s.fails).sort((a, b) => b[1] - a[1]);
  const total = Object.values(s.fails).reduce((a, b) => a + b, 0);
  return <div className="vb vb-servers">
    <header className="vb-pro-head"><h1>Какие серверы надёжны и насколько</h1>
      <p>Надёжность — доля удачных проверок, недавние весят больше. Считается отдельно для белых списков и для обычного интернета. Надёжный — от 3 проверок, от 70% удачных и последняя удачная.</p></header>
    <div className="vb-stats">
      <div><small>Серверов в подписке {board.provider.name}</small><b>{board.provider.total}</b></div>
      <div><small>Отвечают сейчас</small><b>{s.answering}</b><span>обход {ago(board.provider.checked_at)}</span></div>
      <div><small>Надёжных при белых списках</small><b>{s.stable.whitelist || 0}</b></div>
      <div><small>Надёжных при обычном интернете</small><b>{s.stable.normal || 0}</b></div>
      <div className="vb-fails"><small>Почему молчат остальные</small>
        <span className="vb-failbar" role="img" aria-label={fails.map(([k, v]) => `${NOW_TEXT[k] || k}: ${v}`).join(", ")}>{fails.map(([k, v]) => <i key={k} data-kind={k} style={{ flexGrow: v }} />)}</span>
        <span>{fails.map(([k, v]) => `${(NOW_TEXT[k] || k).replace("молчит · ", "")} ${v}`).join(" · ")}{total ? "" : "все отвечают"}</span></div>
    </div>
    <div className="vb-toolbar">
      <div className="vb-seg" role="group" aria-label="Режим канала">{MODES.map(([m, t]) => <button key={m} type="button" aria-pressed={current === m} onClick={() => { setMode(m); setLimit(PAGE); }}>{t}{board.channel.mode === m ? " · сейчас" : ""}</button>)}</div>
      <label className="vb-check"><input type="checkbox" checked={onlyGood} onChange={e => { setOnlyGood(e.target.checked); setLimit(PAGE); }} /> только надёжные и отвечающие</label>
      <label className="vb-search"><span className="sr-only">Найти</span><input type="search" placeholder="Найти сервер или группу" value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE); }} /></label>
    </div>
    <div className="vb-table-wrap"><table className="vb-table">
      <thead><tr><th>Сервер</th><th>Надёжность {current === "whitelist" ? "при белых списках" : "при обычном"}</th><th>Задержка</th><th>Проверок</th><th>Сейчас</th><th>Где стоит</th></tr></thead>
      <tbody>{rows.slice(0, limit).map(r => <tr key={r.name}>
        <td><b>{r.name}</b><small data-good={r.stable ? "yes" : undefined}>{tag(r)}</small></td>
        <td><span className="vb-rate"><span className="vb-rate-bar"><i data-tone={rateTone(r.rate)} style={{ width: `${Math.max(2, r.rate * 100)}%` }} /></span>{pct(r.rate)}</span></td>
        <td>{r.ms > 0 ? `${r.ms} мс` : "—"}</td>
        <td>{r.checks.toLocaleString("ru-RU")}</td>
        <td><span className="vb-chip" data-tone={r.now === "ok" ? "ok" : r.now === "unknown" || r.now === "skipped" ? "none" : "bad"}>{NOW_TEXT[r.now] || r.now}</span></td>
        <td>{r.selected?.length ? <span className="vb-where">выбран в {r.selected.join(", ")}</span> : <span className="vb-muted">—</span>}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="vb-muted">Показаны {Math.min(limit, rows.length)} из {rows.length}{onlyGood ? ` (всего в подписке ${s.rows[current]?.length || 0})` : ""}{rows.length > limit && <> · <button type="button" className="vb-link" onClick={() => setLimit(l => l + PAGE * 4)}>показать ещё</button></>}</p>
  </div>;
}
