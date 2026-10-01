import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, EmptyState } from "../../components/ui/controls";
import { bytes, errText, number, timeOf } from "../../lib/format";
import { mihomo, type AdaptiveHealth, type AdaptiveNode, type AdaptiveProbe, type AdaptiveResult, type MProvider } from "./api";
import { useMihomo } from "./context";
import { AdaptiveModeBadge } from "./Proxies";
import { TabCount, Tabs } from "./shared";

type View = "normal" | "whitelist" | "results";
const STAGES = ["dial", "tls/http", "http", "body", "ok"];
const STAGE_LABEL: Record<string, string> = { dial: "подключение", "tls/http": "TLS", http: "HTTP", body: "тело", ok: "готово" };

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ProbeList({ probes }: { probes: AdaptiveProbe[] | null }) {
  if (!probes?.length) return <span className="mh-muted">нет данных</span>;
  return (
    <span className="mh-probes">
      {probes.map((p) => (
        <span key={p.url} className={`badge ${p.ok ? "badge-success" : "badge-danger"}`} title={`${p.url}${p.status ? ` · ${p.status}` : ""}${p.error ? ` · ${p.error}` : ""}`}>
          {hostOf(p.url)} {p.ok ? `${p.ms} мс` : p.status ? p.status : "нет"}
        </span>
      ))}
    </span>
  );
}

// Stages a probe passed: everything before the one it stopped at.
function Stages({ probes }: { probes: AdaptiveProbe[] }) {
  const worst = probes.reduce((acc, p) => (p.ok ? acc : Math.min(acc, Math.max(0, STAGES.indexOf(p.stage)))), STAGES.length);
  return (
    <span className="mh-stages">
      {STAGES.slice(0, 4).map((s, i) => (
        <span key={s} className={i < worst ? "is-ok" : i === worst ? "is-fail" : "is-skip"}>
          {STAGE_LABEL[s]}
        </span>
      ))}
    </span>
  );
}


/**
 * Status with the fork's thresholds (MIHOMO-5): `ok` is the last probe,
 * `available` is admission after failure-/recovery-threshold.
 */
function NodeStatus({ rank, r, base }: { rank?: AdaptiveNode; r?: AdaptiveResult; base?: string }) {
  if (r?.skipped)
    return (
      <span className="badge" title={`Узел ещё не прошёл базовую проверку${base ? ` подписки ${base}` : ""}: сервис его не проверял, статистика не менялась`}>
        ждёт базу
      </span>
    );
  const fails = r?.consecutiveFailures || 0;
  const oks = r?.consecutiveSuccesses || 0;
  if (r && r.available === true && !r.ok)
    return <span className="badge badge-warning" title="Последняя проба провалилась, но узел ещё в пределах failure-threshold">держится · ошибок {fails}</span>;
  if (r && r.available === false && r.ok)
    return <span className="badge badge-warning" title="Проба успешна, но для возврата нужно recovery-threshold успехов подряд">возвращается · успехов {oks}</span>;
  if (r && r.available === false) return <span className="badge badge-danger" title={`Ошибок подряд: ${fails}`}>исключён</span>;
  if (rank?.stable) return <span className="badge badge-success">стабильный</span>;
  if (r && !r.ok) return <span className="badge badge-danger">не проходит</span>;
  if (r?.available) return <span className="badge badge-success">доступен</span>;
  return rank ? <span className="badge">наблюдается</span> : <span className="badge">нет истории</span>;
}

function lastProbe(h: AdaptiveHealth, name: string) {
  const r = h.results?.[name];
  if (!r) return null;
  const probes = r.probes || [];
  const failed = probes.find((p) => !p.ok);
  const ms = Math.max(0, ...probes.map((p) => p.ms));
  return { r, probes, failed, ms, bytes: probes.reduce((s, p) => s + (p.bytes || 0), 0) };
}

export function Checks({ onConfig }: { onConfig: () => void }) {
  const { act } = useMihomo();
  const [providers, setProviders] = useState<Record<string, MProvider>>({});
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<View | "">("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProviders((await mihomo.providers()).providers || {});
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const list = Object.values(providers).filter((p) => p.vehicleType !== "Compatible" && p.name !== "default");
  const adaptive = list.filter((p) => p.adaptive);
  const current = adaptive.find((p) => p.name === selected) || adaptive[0];
  const h = current?.adaptive;
  const activeView: View = view || (h?.mode === "whitelist" ? "whitelist" : "normal");

  const rows = useMemo(() => {
    if (!h || !current) return [] as Array<{ name: string; rank?: AdaptiveNode }>;
    if (activeView === "results") return current.proxies.map((p) => ({ name: p.name, rank: [...(h.rankings.normal || []), ...(h.rankings.whitelist || [])].find((r) => r.name === p.name) }));
    return (h.rankings[activeView] || []).map((rank) => ({ name: rank.name, rank }));
  }, [h, current, activeView]);

  const stableCount = (m: "normal" | "whitelist") => (h?.rankings[m] || []).filter((r) => r.stable).length;
  const skipped = Object.values(h?.results || {}).filter((r) => r.skipped).length;
  const base = h?.dependsOn ? providers[h.dependsOn] : undefined;

  return (
    <div className="stack">
      <PageHeader
        page="checks"
        actions={
          <>
            {adaptive.length > 1 ? (
              <select aria-label="Подписка" value={current?.name || ""} onChange={(e) => setSelected(e.target.value)}>
                {adaptive.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.adaptive?.dependsOn ? `${p.name} ← ${p.adaptive.dependsOn}` : p.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!current || busy}
              onClick={async () => {
                setBusy(true);
                await act(`Проверка ${current!.name}`, () => mihomo.healthcheck(current!.name), "Обход узлов запущен");
                setBusy(false);
                await load();
              }}
            >
              {busy ? <span className="spinner" /> : <Icon name="bolt" />}
              Проверить сейчас
            </button>
          </>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      {!h ? (
        <EmptyState
          icon="activity"
          title="Адаптивная проверка не включена"
          action={
            <button type="button" className="btn btn-primary" onClick={onConfig}>
              Открыть подписки
            </button>
          }
        >
          {list.length
            ? `Подписки ${list.map((p) => p.name).join(", ")} проверяются обычным HEAD-запросом. Включите «Адаптивную» проверку в настройках подписки: она отличает обычную сеть от белых списков и ведёт для них отдельные рейтинги.`
            : "Подписок нет. Добавьте первую в «Конфигурации»."}
          {h === undefined && list.length ? " Нужен бинарник форка x-happy-x/mihomo." : ""}
        </EmptyState>
      ) : (
        <>
          <div className="stats mh-stats">
            <div className={`stat mh-mode is-${h.mode}`}>
              <span className="stat-label">Режим сети</span>
              <span className="stat-value">
                <AdaptiveModeBadge mode={h.mode} />
              </span>
              <span className="stat-meta">
                {h.pending && h.observed !== h.mode ? `замечен «${h.observed}», подтверждение ${h.pending}` : "подтверждён"}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Разрешённые адреса напрямую</span>
              <span className="stat-value">
                {(h.directAllowed || []).filter((p) => p.ok).length} / {(h.directAllowed || []).length}
              </span>
              <span className="stat-meta">
                <ProbeList probes={h.directAllowed} />
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Глобальные адреса напрямую</span>
              <span className="stat-value">
                {(h.directGlobal || []).filter((p) => p.ok).length} / {(h.directGlobal || []).length}
              </span>
              <span className="stat-meta">
                <ProbeList probes={h.directGlobal} />
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Последний обход</span>
              <span className="stat-value">{h.checkedAt && !h.checkedAt.startsWith("0001") ? timeOf(h.checkedAt) : "—"}</span>
              <span className="stat-meta">
                проверено {number(Object.values(h.results || {}).filter((r) => !r.skipped).length)} из {number(current!.proxies.length)}
                {skipped ? ` · ждут базу ${number(skipped)}` : ""}
              </span>
            </div>
          </div>
          {h.dependsOn ? (
            <Alert
              tone="info"
              title={`Каскад: сначала подписка ${h.dependsOn}`}
              action={
                base ? (
                  <button type="button" className="btn btn-sm" onClick={() => setSelected(h.dependsOn!)}>
                    Открыть {h.dependsOn}
                  </button>
                ) : null
              }
            >
              Сервисная проверка отправляет запрос только узлам, которые свежо прошли базовую проверку {h.dependsOn} в том же режиме сети. Остальные помечены «ждёт базу» и в статистику сервиса не попадают.
              {base?.adaptive ? ` Сейчас база допускает ${number(Object.values(base.adaptive.results || {}).filter((r) => r.available).length)} из ${number(base.proxies.length)} узлов.` : ""}
            </Alert>
          ) : null}
          {h.persistenceError ? <Alert tone="warning" title="История проверок не сохраняется">{h.persistenceError}</Alert> : null}
          <Tabs<View>
            label="Рейтинг"
            value={activeView}
            onChange={setView}
            items={[
              ["normal", <>Без ограничений <TabCount n={stableCount("normal")} /></>],
              ["whitelist", <>При белых списках <TabCount n={stableCount("whitelist")} /></>],
              ["results", <>Все узлы <TabCount n={current!.proxies.length} /></>],
            ]}
          />
          <section className="card card-flush">
            {rows.length ? (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead>
                    <tr>
                      <th>Узел</th>
                      <th className="col-shrink">Статус</th>
                      <th className="col-num">Успех</th>
                      <th className="col-num">Проверок</th>
                      <th className="col-num">GET</th>
                      <th className="col-num">Оценка</th>
                      <th>Последняя проба</th>
                      <th>Этапы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ name, rank }) => {
                      const lp = lastProbe(h, name);
                      return (
                        <tr key={name}>
                          <td className="cell-primary" data-label="">
                            <strong>{name}</strong>
                          </td>
                          <td className="col-shrink" data-label="Статус">
                            <NodeStatus rank={rank} r={lp?.r} base={h.dependsOn} />
                          </td>
                          <td className="col-num mono" data-label="Успех">{rank ? `${Math.round(rank.successRate * 100)}%` : "—"}</td>
                          <td className="col-num mono" data-label="Проверок">{rank ? number(rank.record.checks) : "—"}</td>
                          <td className="col-num mono" data-label="GET">{rank && rank.record.avgMs ? `${Math.round(rank.record.avgMs)} мс` : "—"}</td>
                          <td className="col-num mono" data-label="Оценка">{rank ? number(rank.score) : "—"}</td>
                          <td data-label="Проба">
                            {lp?.r.skipped ? (
                              <span className="mh-muted">не проверялся: база не допустила узел</span>
                            ) : lp ? (
                              <span className="cell-sub">
                                {timeOf(lp.r.at)} · {lp.r.mode} · {lp.failed ? `${hostOf(lp.failed.url)} · ${STAGE_LABEL[lp.failed.stage] || lp.failed.stage}: ${lp.failed.error || lp.failed.status || "ошибка"}` : `${lp.ms} мс · ${bytes(lp.bytes)}`}
                              </span>
                            ) : (
                              <span className="mh-muted">—</span>
                            )}
                          </td>
                          <td data-label="Этапы">{lp && !lp.r.skipped && lp.probes.length ? <Stages probes={lp.probes} /> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="activity" title="Рейтинг пока пуст">
                Рейтинг для этого режима появится после подтверждённых обходов в нём. Пока режим не подтверждён, результаты в историю не пишутся.
              </EmptyState>
            )}
            <div className="card-footer">
              Стабильный узел: от 3 проверок, успех от 70%, последняя проверка успешна и не старше 7 дней. «Держится» и «возвращается» — пороги failure-threshold и recovery-threshold подписки. Оценка = успех × 1000 / (задержка + 100). Данные обновляются каждые 10 секунд.
            </div>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Как определяется режим</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={onConfig}>
                Настроить проверку
              </button>
            </div>
            <div className="card-body mh-legend">
              <span><span className="badge badge-success">без ограничений</span> напрямую отвечает хотя бы один глобальный адрес</span>
              <span><span className="badge badge-warning">белые списки</span> разрешённые адреса отвечают, глобальные — нет</span>
              <span><span className="badge badge-danger">нет сети</span> не ответили обе группы</span>
              <span className="mh-muted">Режим меняется после нескольких одинаковых наблюдений подряд; пока он не подтверждён, результаты не попадают в рейтинги.</span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
