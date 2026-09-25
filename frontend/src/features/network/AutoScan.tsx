import { useCallback, useEffect, useState } from "react";
import { fetchScan, runScan, saveScanSettings, type Analysis, type ScanPayload, type ScanSettings } from "../../api";
import { Icon } from "../../components/ui/Icon";
import { Alert, Segmented, Switch } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { ANALYSIS_VERDICT, PATH_TITLES, Tag, formatAgo, pathVerdict } from "./shared";

// «Автопроверка»: the analyzer on a schedule over a list of sites, with a
// verdict history so a new block (or a lifted one) stands out.

const INTERVALS = [
  { value: "15", label: "15 мин" },
  { value: "60", label: "1 ч" },
  { value: "180", label: "3 ч" },
  { value: "720", label: "12 ч" },
  { value: "1440", label: "сутки" },
];

export function AutoScan({ onOpen }: { onOpen: (a: Analysis) => void }) {
  const [data, setData] = useState<ScanPayload | null>(null);
  const [draft, setDraft] = useState<ScanSettings | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchScan();
      setData(next);
      setDraft((d) => d ?? next.settings);
      setText((t) => t || next.settings.targets.join("\n"));
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data || !draft) return error ? <Alert tone="danger" title="Нет данных">{error}</Alert> : <div className="launcher-loading">Загружаю…</div>;

  const targets = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const dirty =
    JSON.stringify({ ...draft, targets }) !== JSON.stringify(data.settings) ||
    draft.enabled !== data.settings.enabled;

  const save = async (patch: Partial<ScanSettings> = {}) => {
    setSaving(true);
    try {
      const saved = await saveScanSettings({ ...draft, targets, ...patch });
      setDraft(saved);
      setText(saved.targets.join("\n"));
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const addPreset = (list: string[]) => {
    const have = new Set(targets);
    setText([...targets, ...list.filter((t) => !have.has(t))].join("\n"));
  };

  return (
    <div className="net-stack">
      {error ? <Alert tone="danger" title="Ошибка">{error}</Alert> : null}
      <div className="grid-2 net-grid net-scan-top">
        <div className="card card-body net-scan-settings">
          <Switch
            checked={draft.enabled}
            onChange={(v) => void save({ enabled: v })}
            label="Проверять автоматически"
            hint={data.settings.enabled ? (data.next_run ? `следующая проверка ${formatAgoFuture(data.next_run)}` : "скоро") : "выключено — только вручную"}
            disabled={saving}
          />
          <div className="field">
            <span className="field-label">Как часто</span>
            <Segmented
              label="Интервал"
              value={String(draft.interval_min)}
              onChange={(v) => setDraft({ ...draft, interval_min: Number(v) })}
              options={INTERVALS.some((i) => i.value === String(draft.interval_min)) ? INTERVALS : [...INTERVALS, { value: String(draft.interval_min), label: `${draft.interval_min} мин` }]}
            />
          </div>
          <div className="field">
            <span className="field-label">Пути</span>
            <div className="net-form-paths">
              {Object.entries(PATH_TITLES).map(([id, label]) => (
                <label key={id} className="net-check-label">
                  <input
                    type="checkbox"
                    checked={draft.paths.includes(id)}
                    onChange={(e) => setDraft({ ...draft, paths: e.target.checked ? [...draft.paths, id] : draft.paths.filter((p) => p !== id) })}
                  />
                  <span>
                    <b>{label}</b>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
              <Icon name="save" size={15} />
              Сохранить
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={data.running || dirty}
              title={dirty ? "Сначала сохраните список" : undefined}
              onClick={() => void runScan().then(load).catch((err) => setError(errText(err)))}
            >
              {data.running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={15} />}
              {data.running ? `Проверяю ${data.progress}` : "Проверить сейчас"}
            </button>
          </div>
          <p className="muted net-note">
            {data.last_run ? `Последний прогон ${formatAgo(data.last_run)}.` : "Прогонов ещё не было."} Сайты проверяются по одному, прогон из 20 сайтов идёт 3–6 минут.
          </p>
        </div>
        <div className="card card-body net-scan-targets">
          <label className="field">
            <span className="field-label">Сайты — по одному в строке ({targets.length} из 60)</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} spellCheck={false} className="mono" />
          </label>
          <div className="chip-list">
            {data.presets.map((p) => (
              <button key={p.id} type="button" className="chip" title={p.description} onClick={() => addPreset(p.targets)}>
                <Icon name="plus" size={12} /> {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="res-section">
        <header className="res-section-head">
          <div>
            <h2>Результаты</h2>
            <p>Сначала проблемные. Полоска — последние прогоны, слева направо от старых к новым. Нажмите на строку, чтобы открыть разбор.</p>
          </div>
        </header>
        {data.results.length === 0 ? (
          <div className="card card-body muted">Результатов пока нет — запустите проверку.</div>
        ) : (
          <div className="card table-wrap">
            <table className="table net-scan-table">
              <thead>
                <tr>
                  <th>Сайт</th>
                  <th>Итог</th>
                  {Object.entries(PATH_TITLES).map(([id, label]) => (
                    <th key={id}>{label}</th>
                  ))}
                  <th>История</th>
                  <th>Проверено</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((row) => {
                  const v = ANALYSIS_VERDICT[row.last.verdict] || { tone: "neutral" as const, label: row.last.verdict };
                  const changed = row.history.length > 1 && row.history[row.history.length - 1].changed;
                  return (
                    <tr key={row.target} className="net-scan-row" onClick={() => onOpen(row.last)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(row.last)}>
                      <td>
                        <div className="cell-title">{row.last.host}</div>
                        {changed ? <span className="badge badge-warning">изменилось</span> : null}
                      </td>
                      <td>
                        <Tag tone={v.tone}>{v.label}</Tag>
                      </td>
                      {Object.keys(PATH_TITLES).map((id) => {
                        const p = row.last.paths.find((x) => x.id === id);
                        if (!p) return <td key={id} className="muted">—</td>;
                        const pv = pathVerdict(p.verdict);
                        return (
                          <td key={id} title={p.summary}>
                            <Tag tone={pv.tone}>{pv.label}</Tag>
                          </td>
                        );
                      })}
                      <td>
                        <span className="net-history" aria-label="История проверок">
                          {row.history.slice(-24).map((h) => {
                            const hv = ANALYSIS_VERDICT[h.verdict as keyof typeof ANALYSIS_VERDICT];
                            return <i key={h.at} className={`net-hist net-hist-${hv?.tone || "neutral"}`} title={`${new Date(h.at * 1000).toLocaleString("ru-RU")}: ${hv?.label || h.verdict}`} />;
                          })}
                        </span>
                      </td>
                      <td className="muted">{formatAgo(row.last.at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function formatAgoFuture(unix: number) {
  const sec = Math.round(unix - Date.now() / 1000);
  if (sec <= 60) return "в течение минуты";
  if (sec < 3600) return `через ${Math.round(sec / 60)} мин`;
  return `через ${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}
