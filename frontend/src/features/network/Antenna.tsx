import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLTE, startLTELoad, startLTESurvey, type LteCarrier, type LteLive, type LtePayload, type LteSurvey } from "../../api";
import { TimeChart } from "../../components/charts/TimeChart";
import { Icon } from "../../components/ui/Icon";
import { Alert } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { formatBps } from "../../pages/Resources";
import { Tag, formatClock, type Tone } from "./shared";

// «Антенна»: aiming the MikroTik's LTE antenna. A live reading (every 1.5 s
// while aiming), a short load so the network turns aggregation on, saved
// positions to compare, and a band survey that locks the modem band by band.

const ALL_BANDS = [1, 3, 5, 7, 8, 20, 28, 38, 40, 41];
const DEFAULT_BANDS = [1, 3, 7, 20, 38];
const MARKS_KEY = "homenet.lte.marks";

type Mark = { label: string; at: number; rsrp: number; sinr: number; rsrq: number; band: string; pci: number; enb: string; carriers: string; mhz: number; peak: number };

// Thresholds for words next to the numbers (usual LTE practice).
function rsrpTone(v: number): [Tone, string] {
  return v >= -80 ? ["good", "отлично"] : v >= -90 ? ["good", "хорошо"] : v >= -100 ? ["warning", "средне"] : ["critical", "слабо"];
}
function sinrTone(v: number): [Tone, string] {
  return v >= 20 ? ["good", "отлично"] : v >= 13 ? ["good", "хорошо"] : v >= 0 ? ["warning", "средне"] : ["critical", "плохо"];
}
function rsrqTone(v: number): [Tone, string] {
  return v >= -10 ? ["good", "отлично"] : v >= -15 ? ["good", "хорошо"] : v >= -20 ? ["warning", "средне"] : ["critical", "плохо"];
}

export function carriersText(list: LteCarrier[] | undefined) {
  const active = (list || []).filter((c) => c.active);
  if (!active.length) return "—";
  return active.map((c) => `${c.band}${c.width_mhz ? ` ${c.width_mhz} МГц` : ""}`).join(" + ");
}

function readMarks(): Mark[] {
  try {
    return JSON.parse(localStorage.getItem(MARKS_KEY) || "[]") as Mark[];
  } catch {
    return [];
  }
}

function saveMarks(list: Mark[]) {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* per-browser convenience */
  }
}

export function Antenna() {
  const [data, setData] = useState<LtePayload | null>(null);
  const [error, setError] = useState("");
  const [aiming, setAiming] = useState(false);
  const [trail, setTrail] = useState<LteLive[]>([]);
  const [marks, setMarks] = useState<Mark[]>(readMarks);
  const [label, setLabel] = useState("");
  const [bands, setBands] = useState<number[]>(DEFAULT_BANDS);
  const [surveyLabel, setSurveyLabel] = useState("");
  const [confirmSurvey, setConfirmSurvey] = useState(false);
  const peak = useRef(0);

  const load = useCallback(async () => {
    try {
      const next = await fetchLTE();
      setData(next);
      setError(next.error || "");
      if (next.live) {
        const live = next.live;
        peak.current = Math.max(peak.current, live.rx_bps);
        setTrail((t) => [...t.filter((x) => x.at > live.at - 180), live]);
      }
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const every = aiming || data?.busy ? 1500 : 10000;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, every);
    return () => clearInterval(timer);
  }, [load, aiming, data?.busy]);

  const live = data?.live;
  const loading = (data?.load_until || 0) > Date.now() / 1000;
  const survey = data?.survey;
  const surveying = !!data?.busy;

  const remember = () => {
    if (!live) return;
    const mark: Mark = {
      label: label.trim() || `положение ${marks.length + 1}`,
      at: live.at,
      rsrp: live.rsrp,
      sinr: live.sinr,
      rsrq: live.rsrq,
      band: live.band,
      pci: live.pci,
      enb: live.enb,
      carriers: carriersText(live.carriers),
      mhz: live.total_mhz,
      peak: peak.current,
    };
    const next = [mark, ...marks];
    setMarks(next);
    saveMarks(next);
    setLabel("");
    peak.current = 0;
  };

  const times = trail.map((x) => x.at);
  const scc = (live?.carriers || []).filter((c) => c.role === "scc");

  return (
    <div className="net-stack">
      {error ? <Alert tone="warning" title="Модем">{error}</Alert> : null}
      {surveying ? (
        <Alert tone="info" title={`Идёт обзор диапазонов${survey?.current ? ` · сейчас B${survey.current}` : ""}`}>
          Интернет через LTE сейчас прерывается. Настройки диапазонов вернутся сами в конце; если что-то пойдёт не так — MikroTik вернёт их через 15 минут.
        </Alert>
      ) : null}

      <section className="card net-aim">
        <header className="net-aim-head">
          <div>
            <h2>Наведение антенны</h2>
            <p className="muted">
              {aiming ? "Показания обновляются каждые 1,5 с — поворачивайте антенну медленно, ждите 3–5 с в каждом положении." : "Включите наведение, чтобы показания обновлялись быстро."}
            </p>
          </div>
          <button type="button" className={`btn ${aiming ? "btn-secondary" : "btn-primary"}`} onClick={() => setAiming((v) => !v)} disabled={surveying}>
            <Icon name={aiming ? "close" : "play"} size={15} />
            {aiming ? "Остановить" : "Начать наведение"}
          </button>
        </header>

        {live ? (
          <>
            <div className="net-aim-grid">
              <Reading name="RSRP" value={live.rsrp} unit="дБм" tone={rsrpTone(live.rsrp)} hint="сила сигнала" />
              <Reading name="SINR" value={live.sinr} unit="дБ" tone={sinrTone(live.sinr)} hint="чистота сигнала — главное при наведении" />
              <Reading name="RSRQ" value={live.rsrq} unit="дБ" tone={rsrqTone(live.rsrq)} hint="качество с учётом соседей" />
              <div className="net-reading">
                <span className="net-reading-name">Скорость сейчас</span>
                <strong>↓ {formatBps(live.rx_bps)}</strong>
                <span className="muted">↑ {formatBps(live.tx_bps)}</span>
              </div>
            </div>

            <div className={`net-ca net-ca-${scc.some((c) => c.active) ? "on" : "off"}`}>
              <div>
                <span className="net-reading-name">Агрегация частот</span>
                <div className="net-ca-carriers">
                  {live.carriers.map((c) => (
                    <span key={c.role + c.band + c.earfcn} className={`net-carrier${c.active ? " is-active" : ""}`} title={c.earfcn ? `EARFCN ${c.earfcn}, PCI ${c.pci}` : undefined}>
                      <b>{c.band}</b>
                      {c.width_mhz ? ` ${c.width_mhz} МГц` : ""}
                      <small>{c.role === "pcc" ? "основная" : c.active ? "добавлена" : "настроена, не активна"}</small>
                    </span>
                  ))}
                </div>
                <p className="muted">
                  {scc.some((c) => c.active)
                    ? `Работает: ${live.carriers.filter((c) => c.active).length} частоты, всего ${live.total_mhz} МГц.`
                    : "Сейчас одна частота. Сеть включает агрегацию только при нагрузке — нажмите «Нагрузить», чтобы проверить это положение."}
                </p>
              </div>
              <div className="net-ca-actions">
                <button type="button" className="btn btn-secondary" disabled={loading || surveying} onClick={() => void startLTELoad(15).then(load).catch((e) => setError(errText(e)))}>
                  {loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" size={15} />}
                  {loading ? `Нагрузка… ${Math.max(0, Math.round((data?.load_until || 0) - Date.now() / 1000))} с` : "Нагрузить 15 с"}
                </button>
                <small className="muted">скачивание на MikroTik, ≈ 50–150 МБ мобильного трафика</small>
              </div>
            </div>

            <dl className="net-cellinfo">
              <div>
                <dt>Сота</dt>
                <dd>
                  {live.operator} · eNB {live.enb || "—"} · сектор {live.sector || "—"}
                </dd>
              </div>
              <div>
                <dt>Частота</dt>
                <dd>
                  {live.band} · EARFCN {live.earfcn} · PCI {live.pci}
                </dd>
              </div>
              <div>
                <dt>Модуляция</dt>
                <dd>
                  {live.modulation || "—"} · MCS {live.mcs} · CQI {live.cqi} · RI {live.ri}
                </dd>
              </div>
              <div>
                <dt>Диапазоны модема</dt>
                <dd>{live.band_lock ? `закреплены: ${live.band_lock}` : "все, выбирает сеть"}</dd>
              </div>
            </dl>

            {trail.length > 2 ? (
              <div className="grid-2 net-grid">
                <div>
                  <span className="net-reading-name">SINR за 3 минуты</span>
                  <TimeChart label="SINR" times={times} series={[{ label: "SINR, дБ", values: trail.map((x) => x.sinr) }]} format={(v) => `${v.toFixed(0)} дБ`} height={80} />
                </div>
                <div>
                  <span className="net-reading-name">RSRP за 3 минуты</span>
                  <TimeChart label="RSRP" times={times} series={[{ label: "RSRP, дБм", values: trail.map((x) => x.rsrp) }]} format={(v) => `${v.toFixed(0)} дБм`} height={80} area={false} />
                </div>
              </div>
            ) : null}

            {live.neighbours.length ? (
              <div>
                <span className="net-reading-name">Соседние соты, которые слышит модем</span>
                <div className="net-neigh">
                  {live.neighbours.map((c) => (
                    <span key={c.earfcn + "/" + c.pci} className="badge badge-mono">
                      {c.band || c.earfcn} · PCI {c.pci} · {c.rsrp} дБм
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="net-mark-row">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Положение, например «азимут 120°»" aria-label="Название положения" />
              <button type="button" className="btn btn-secondary" onClick={remember}>
                <Icon name="plus" size={15} />
                Запомнить положение
              </button>
            </div>
          </>
        ) : !error ? (
          <div className="launcher-loading">Читаю модем…</div>
        ) : null}
      </section>

      {marks.length ? (
        <section className="res-section">
          <header className="res-section-head">
            <div>
              <h2>Сохранённые положения</h2>
              <p>Хранятся в этом браузере. Лучшее по SINR отмечено.</p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setMarks([]);
                saveMarks([]);
              }}
            >
              Очистить
            </button>
          </header>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Положение</th>
                  <th>SINR</th>
                  <th>RSRP</th>
                  <th>RSRQ</th>
                  <th>Сота</th>
                  <th>Частоты</th>
                  <th>Пик ↓</th>
                </tr>
              </thead>
              <tbody>
                {marks.map((m) => {
                  const best = Math.max(...marks.map((x) => x.sinr)) === m.sinr;
                  return (
                    <tr key={m.at + m.label}>
                      <td>
                        <div className="cell-title">
                          {m.label} {best ? <Tag tone="good">лучшее</Tag> : null}
                        </div>
                        <div className="cell-sub">{formatClock(m.at)}</div>
                      </td>
                      <td>{m.sinr} дБ</td>
                      <td>{m.rsrp} дБм</td>
                      <td>{m.rsrq} дБ</td>
                      <td>
                        {m.band} · PCI {m.pci}
                        <div className="cell-sub">eNB {m.enb}</div>
                      </td>
                      <td>{m.carriers}</td>
                      <td>{m.peak ? formatBps(m.peak) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>Обзор диапазонов</h2>
            <p>
              Модем слышит только частоты своей соты. Чтобы узнать, какие ещё есть вокруг, он по очереди закрепляется на каждом диапазоне. На время обзора интернет пропадает — около 40 с на
              диапазон.
            </p>
          </div>
        </header>
        <div className="card card-body net-survey-form">
          <div className="net-form-paths">
            {ALL_BANDS.map((b) => (
              <label key={b} className="net-check-label">
                <input type="checkbox" checked={bands.includes(b)} onChange={(e) => setBands((list) => (e.target.checked ? [...list, b].sort((x, y) => x - y) : list.filter((x) => x !== b)))} />
                <span>
                  <b>B{b}</b>
                </span>
              </label>
            ))}
          </div>
          <div className="net-mark-row">
            <input value={surveyLabel} onChange={(e) => setSurveyLabel(e.target.value)} placeholder="Положение антенны (необязательно)" aria-label="Положение антенны" />
            {confirmSurvey ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirmSurvey(false);
                    void startLTESurvey(bands, surveyLabel)
                      .then(load)
                      .catch((e) => setError(errText(e)));
                  }}
                >
                  Прервать интернет ≈ {Math.round((bands.length * 40) / 60) || 1} мин и начать
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmSurvey(false)}>
                  Отмена
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" disabled={surveying || bands.length === 0} onClick={() => setConfirmSurvey(true)}>
                {surveying ? <span className="spinner" aria-hidden="true" /> : <Icon name="search" size={15} />}
                {surveying ? `Обзор: B${survey?.current ?? ""}` : "Начать обзор"}
              </button>
            )}
          </div>
        </div>
        {survey ? <SurveyView survey={survey} live={surveying} /> : null}
        {(data?.history || []).filter((h) => h.id !== survey?.id).map((h) => (
          <details key={h.id} className="card net-survey-old">
            <summary>
              {h.label || "Без названия"} · {formatClock(h.started)} · найдено: {h.results.filter((r) => r.found).map((r) => "B" + r.band).join(", ") || "ничего"}
            </summary>
            <SurveyView survey={h} live={false} />
          </details>
        ))}
      </section>
    </div>
  );
}

function Reading({ name, value, unit, tone, hint }: { name: string; value: number; unit: string; tone: [Tone, string]; hint: string }) {
  return (
    <div className={`net-reading net-reading-${tone[0]}`} title={hint}>
      <span className="net-reading-name">{name}</span>
      <strong>
        {value} <small>{unit}</small>
      </strong>
      <Tag tone={tone[0]}>{tone[1]}</Tag>
    </div>
  );
}

function SurveyView({ survey, live }: { survey: LteSurvey; live: boolean }) {
  const found = survey.results.filter((r) => r.found);
  return (
    <div className="card net-survey">
      <div className="net-survey-head">
        <b>{survey.label || "Обзор"}</b>
        <span className="muted">{formatClock(survey.started)}</span>
        {survey.error ? <Tag tone="critical">{survey.error}</Tag> : null}
        {!live && survey.finished ? survey.restored ? <Tag tone="good">настройки возвращены</Tag> : <Tag tone="warning">настройки не вернулись</Tag> : null}
      </div>
      {found.length >= 2 ? (
        <p className="net-survey-verdict">
          В этом положении слышно {found.map((r) => "B" + r.band).join(", ")} — агрегация возможна, если оператор объединяет эти диапазоны на одной станции.
        </p>
      ) : !live && survey.finished ? (
        <p className="net-survey-verdict muted">Слышен только {found.map((r) => "B" + r.band).join(", ") || "ни один диапазон"} — для агрегации нужно хотя бы два. Попробуйте другое положение.</p>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Диапазон</th>
              <th>Сота</th>
              <th>RSRP</th>
              <th>SINR</th>
              <th>Соседи</th>
            </tr>
          </thead>
          <tbody>
            {survey.bands.map((b) => {
              const r = survey.results.find((x) => x.band === b);
              if (!r)
                return (
                  <tr key={b}>
                    <td>B{b}</td>
                    <td colSpan={4} className="muted">
                      {live && survey.current === b ? "ищу сеть…" : "в очереди"}
                    </td>
                  </tr>
                );
              if (!r.found)
                return (
                  <tr key={b}>
                    <td>
                      <Tag tone="neutral">B{b}</Tag>
                    </td>
                    <td colSpan={4} className="muted">
                      {r.note || "не найдено"}
                    </td>
                  </tr>
                );
              const s = r.serving!;
              return (
                <tr key={b}>
                  <td>
                    <Tag tone="good">B{b}</Tag>
                  </td>
                  <td>
                    eNB {s.enb} · сектор {s.sector}
                    <div className="cell-sub">
                      PCI {s.pci} · EARFCN {s.earfcn} · {s.carriers[0]?.width_mhz ? `${s.carriers[0].width_mhz} МГц` : ""}
                    </div>
                  </td>
                  <td>{s.rsrp} дБм</td>
                  <td>{s.sinr} дБ</td>
                  <td className="muted">{r.cells.length ? r.cells.map((c) => `PCI ${c.pci} (${c.rsrp})`).join(", ") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
