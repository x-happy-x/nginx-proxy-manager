import { useEffect, useState } from "react";
import { PageHeader } from "../../navigation";
import { Icon } from "../../components/ui/Icon";
import { Alert, Field, Segmented, Switch } from "../../components/ui/controls";
import { errText } from "../../lib/format";
import { core, type InstallPlan, type InstallState } from "./api";
import { useMihomo } from "./context";

/** Installs the core from the user's own fork when HomeNet finds no Mihomo. */
export function Install({ compact = false }: { compact?: boolean }) {
  const { status, refreshStatus, log } = useMihomo();
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState("ROUTER");
  const [adaptive, setAdaptive] = useState(true);
  const [xkeen, setXkeen] = useState(false);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [state, setState] = useState<InstallState | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    core.installPlan(xkeen).then(setPlan).catch((err) => setError(errText(err)));
  }, [xkeen]);
  useEffect(() => {
    void core.installLog().then((s) => s.started && setState(s)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => {
      void core.installLog().then((s) => {
        setState(s);
        if (s.done) {
          log("Установка mihomo", s.ok ? `Установлен ${s.version || ""}` : s.log[s.log.length - 1]?.text || "Ошибка", s.ok ? "success" : "error");
          void refreshStatus();
        }
      });
    }, 1500);
    return () => clearInterval(t);
  }, [state?.running, log, refreshStatus]);

  const urlError = url && !/^https?:\/\/\S+$/.test(url.trim()) ? "ссылка должна начинаться с http:// или https://" : "";
  const nameError = !/^[A-Za-z0-9_.-]{1,40}$/.test(provider.trim()) ? "латиница, цифры, точка, дефис, подчёркивание" : "";
  const start = async () => {
    setError("");
    try {
      setState(await core.install({ subscription_url: url.trim(), provider: provider.trim(), adaptive, xkeen }));
    } catch (err) {
      setError(errText(err));
    }
  };
  const stepIndex = (id: string) => plan?.steps.findIndex((s) => s.id === id) ?? -1;
  const current = state ? stepIndex(state.step) : -1;

  return (
    <div className="stack">
      {!compact ? <PageHeader page="core">mihomo не найден на роутере. Установите ядро из релизов форка x-happy-x/mihomo.</PageHeader> : <h2 className="section-title">Установить или переустановить ядро</h2>}
      {error ? <Alert tone="danger" title="Установка не началась">{error}</Alert> : null}
      <div className="grid-2 mh-grid-wide">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Параметры</h2>
            <span className="badge badge-mono">{status?.arch} → {plan?.asset || status?.asset}</span>
          </div>
          <div className="card-body stack">
            <Field label="Ссылка первой подписки" hint={urlError || "Можно оставить пустой и добавить подписку позже в «Конфигурации»."}>
              <input className="mono" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} aria-invalid={!!urlError} disabled={state?.running} />
            </Field>
            <Field label="Название подписки" hint={nameError || undefined}>
              <input value={provider} onChange={(e) => setProvider(e.target.value)} aria-invalid={!!nameError} disabled={state?.running} />
            </Field>
            <Field label="Проверка узлов" group hint={adaptive ? "GET через каждый узел, отдельные рейтинги для обычной сети и белых списков; группа Auto выбирает живой узел." : "Штатная HEAD-проверка."}>
              <Segmented<string> label="Проверка узлов" value={adaptive ? "a" : "h"} onChange={(v) => setAdaptive(v === "a")} options={[{ value: "h", label: "Обычная" }, { value: "a", label: "Адаптивная" }]} disabled={state?.running} />
            </Field>
            <Switch checked={xkeen} onChange={setXkeen} label="Перехват трафика через XKeen" hint="Прозрачное проксирование клиентов. Установщик XKeen задаёт вопросы, поэтому он запускается в SSH; без XKeen создаётся служба S24mihomo." disabled={state?.running} />
            <div className="button-row">
              <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={state?.running || !!urlError || !!nameError}>
                {state?.running ? <span className="spinner" /> : <Icon name="download" />}
                {status?.installed ? "Переустановить ядро" : "Установить"}
              </button>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Что произойдёт</h2>
            <span className="cell-sub">ничего не меняется до нажатия «Установить»</span>
          </div>
          <div className="card-body">
            <ol className="mh-plan">
              {(plan?.steps || []).map((s, i) => {
                const st = !state ? "" : state.done && state.ok ? "is-done" : i < current ? "is-done" : i === current ? (state.running ? "is-active" : state.ok ? "is-done" : "is-failed") : "";
                return (
                  <li key={s.id} className={st}>
                    <strong>{s.title}</strong>
                    {s.note ? <span className="cell-sub">{s.note}</span> : null}
                  </li>
                );
              })}
            </ol>
            {plan?.xkeen_command ? (
              <div className="input-with-button">
                <input className="mono" readOnly value={plan.xkeen_command} aria-label="Команда установки XKeen" />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(plan.xkeen_command!).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  <Icon name={copied ? "check" : "copy"} />
                  {copied ? "Скопировано" : "Копировать"}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      {state ? (
        <section className="card card-flush">
          <div className="card-header">
            <h2 className="card-title">Журнал установки</h2>
            {state.done ? <span className={`badge ${state.ok ? "badge-success" : "badge-danger"}`}>{state.ok ? "готово" : "ошибка"}</span> : <span className="spinner" />}
          </div>
          <div className="mh-log">
            {state.log.map((l, i) => (
              <div key={i} className={`mh-log-line is-${l.level}`}>
                <span className="mh-log-time">{l.time}</span>
                <span className="mh-log-level">{l.level}</span>
                <span className="mh-log-text">{l.text}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
