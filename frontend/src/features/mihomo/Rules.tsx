import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, useHashTab } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, EmptyState, SearchInput } from "../../components/ui/controls";
import { dateTime, errText, number } from "../../lib/format";
import { mihomo, type MRule, type MRuleProvider } from "./api";
import { useMihomo } from "./context";
import { TabCount, Tabs } from "./shared";

type Tab = "rules" | "providers";

export function Rules({ onEdit }: { onEdit: () => void }) {
  const { act } = useMihomo();
  const [tab, setTab] = useHashTab<Tab>("rules", "rules");
  const [rules, setRules] = useState<MRule[]>([]);
  const [providers, setProviders] = useState<Record<string, MRuleProvider>>({});
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([mihomo.rules(), mihomo.ruleProviders()]);
      setRules(r.rules || []);
      setProviders(p.providers || {});
      setError("");
    } catch (err) {
      setError(errText(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const targets = useMemo(() => [...new Set(rules.map((r) => r.proxy))].sort(), [rules]);
  const visible = rules.filter((r) => {
    if (target && r.proxy !== target) return false;
    const q = query.trim().toLowerCase();
    return !q || `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q);
  });
  const providerList = Object.values(providers);
  const hasCounters = rules.some((r) => r.extra);

  const toggle = async (r: MRule) => {
    const disabled = !(r.extra?.disabled ?? r.disabled);
    if (await act("Правило", () => mihomo.disableRules({ [r.index]: disabled }), `${disabled ? "Выключено" : "Включено"}: ${r.type} ${r.payload}`)) await load();
  };

  return (
    <div className="stack">
      <PageHeader
        page="rules"
        actions={
          <>
            <button type="button" className="btn" onClick={() => void load()}>
              <Icon name="refresh" />
              Обновить
            </button>
            <button type="button" className="btn btn-primary" onClick={onEdit}>
              <Icon name="edit" />
              Изменить правила
            </button>
          </>
        }
      />
      {error ? <Alert tone="danger" title="Нет данных от mihomo">{error}</Alert> : null}
      <Tabs<Tab>
        label="Правила"
        value={tab}
        onChange={setTab}
        items={[
          ["rules", <>Правила <TabCount n={rules.length} /></>],
          ["providers", <>Наборы правил <TabCount n={providerList.length} /></>],
        ]}
      />
      {tab === "rules" ? (
        <>
          <div className="toolbar">
            <SearchInput label="Поиск правил" placeholder="Тип, значение или цель" value={query} onChange={setQuery} />
            <select aria-label="Цель" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Все цели</option>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <section className="card card-flush">
            {visible.length ? (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead>
                    <tr>
                      <th className="col-num">#</th>
                      <th>Правило</th>
                      <th>Цель</th>
                      {hasCounters ? <th className="col-num">Срабатываний</th> : null}
                      {hasCounters ? <th>Последнее</th> : null}
                      <th className="col-shrink">Вкл.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, 1000).map((r) => {
                      const off = r.extra?.disabled ?? r.disabled;
                      return (
                        <tr key={r.index} className={off ? "mh-off" : ""}>
                          <td className="col-num mono" data-label="">{r.index + 1}</td>
                          <td className="cell-primary" data-label="">
                            <strong className="break">
                              <span className="method">{r.type}</span> {r.payload}
                            </strong>
                            {r.size > 0 ? <span className="cell-sub">{number(r.size)} записей в наборе</span> : null}
                          </td>
                          <td data-label="Цель">{r.proxy}</td>
                          {hasCounters ? <td className="col-num mono" data-label="Срабатываний">{number(r.extra?.hitCount || 0)}</td> : null}
                          {hasCounters ? <td className="cell-sub" data-label="Последнее">{r.extra?.hitCount && r.extra.hitAt ? dateTime(r.extra.hitAt) : "—"}</td> : null}
                          <td className="col-shrink" data-label="Вкл.">
                            <label className="switch">
                              <input type="checkbox" role="switch" checked={!off} onChange={() => void toggle(r)} aria-label={`Правило ${r.index + 1}`} />
                              <span className="switch-track" aria-hidden="true" />
                            </label>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="list" title="Правил не найдено" />
            )}
            <div className="card-footer">Выключатель действует сразу и до перезапуска ядра. Постоянные изменения порядка и состава правил — в «Конфигурации».</div>
          </section>
        </>
      ) : (
        <section className="card card-flush">
          {providerList.length ? (
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Набор</th>
                    <th>Поведение</th>
                    <th className="col-num">Правил</th>
                    <th>Обновлён</th>
                    <th className="col-shrink" />
                  </tr>
                </thead>
                <tbody>
                  {providerList.map((p) => (
                    <tr key={p.name}>
                      <td className="cell-primary" data-label="">
                        <strong>{p.name}</strong>
                        <span className="cell-sub">
                          {p.vehicleType.toLowerCase()} · {p.format}
                        </span>
                      </td>
                      <td data-label="Поведение">{p.behavior}</td>
                      <td className="col-num mono" data-label="Правил">{number(p.ruleCount)}</td>
                      <td className="cell-sub" data-label="Обновлён">{dateTime(p.updatedAt)}</td>
                      <td className="col-shrink" data-label="">
                        <button type="button" className="btn btn-sm" onClick={() => void act(`Набор ${p.name}`, () => mihomo.updateRuleProvider(p.name), "Обновлён").then(load)}>
                          <Icon name="refresh" />
                          Обновить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="list" title="Наборов правил нет">
              Добавьте rule-provider в «Конфигурации» или используйте GEOSITE/GEOIP.
            </EmptyState>
          )}
        </section>
      )}
    </div>
  );
}
