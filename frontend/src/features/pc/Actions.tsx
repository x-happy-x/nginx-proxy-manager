import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "../../components/ui/Modal";
import { Icon } from "../../components/ui/Icon";
import type { Host } from "../../platform/sdk";
import { ago } from "../pve/model";
import { Dot, Pill } from "../pve/parts";
import { contextName, outdated, usePcPoll, type Action, type ActionRequest, type Computer, type Container, type Distro, type Task } from "./model";

const labels: Record<Action, string> = { start: "Запустить", stop: "Остановить", restart: "Перезапустить", terminate: "Завершить WSL" };
type Target = { h: Computer; context: string; c: Container; w?: never } | { h: Computer; w: Distro; c?: never; context?: never };
type Selection = Target & { action: Action };
type Controls = { select: (selection: Selection) => void; pending: (target: Target) => boolean };
const Context = createContext<Controls>({ select: () => undefined, pending: () => false });

function blocked(target: Target) {
  if (outdated(target.h)) return "Управление недоступно: нет свежего состояния компьютера.";
  const permissions = target.c ? target.h.current?.capabilities.docker_actions : target.h.current?.capabilities.wsl_actions;
  if (!permissions?.length) return "Для управления включите разрешение при установке агента. Инструкция — в настройках.";
  return "";
}
function allowed(target: Target): Action[] {
  const permissions = target.c ? target.h.current?.capabilities.docker_actions || [] : target.h.current?.capabilities.wsl_actions || [];
  const actions: Action[] = target.c
    ? target.c.state === "running" ? ["restart", "stop"] : ["exited", "created"].includes(target.c.state) ? ["start"] : []
    : target.w.state === "running" ? ["terminate"] : ["start"];
  return actions.filter((a) => permissions.includes(a));
}
export function Controls({ target, compact = false }: { target: Target; compact?: boolean }) {
  const { select, pending } = useContext(Context);
  const note = blocked(target);
  const busy = pending(target);
  const permitted = allowed(target);
  const actions: Action[] = target.c ? target.c.state === "running" ? ["restart", "stop"] : ["start"] : target.w.state === "running" ? ["terminate"] : ["start"];
  return <div className="pc-controls"><div className="pc-button-row">{actions.map((action) => <button type="button" key={action} className={`pve-btn${compact ? " pc-icon-btn" : ""}`} disabled={!!note || busy || !permitted.includes(action)}
    aria-label={`${labels[action]} ${target.c?.name || target.w?.name}`} title={note || (busy ? "Операция выполняется" : !permitted.includes(action) ? "Действие не разрешено агентом или состоянием ресурса" : labels[action])} onClick={() => select({ ...target, action })}>{compact ? action === "start" ? "▶" : action === "restart" ? "↻" : "■" : <><Icon name={busy ? "clock" : action === "start" ? "play" : "refresh"} size={13} />{busy ? "Выполняется…" : labels[action]}</>}</button>)}</div>
    {note && !compact ? <span className="pc-control-note"><Icon name="lock" size={12} />{note}</span> : null}</div>;
}

const statuses: Record<Task["status"], string> = { running: "Выполняется", done: "Выполнено", error: "Ошибка", unknown: "Результат неизвестен" };
function Journal({ tasks, error, retry }: { tasks: Task[]; error: string; retry: () => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!tasks.length && !error) return null;
  const active = tasks.filter((t) => t.status === "running").length;
  const visible = expanded ? tasks.slice(0, 20) : tasks.filter((t) => t.status !== "done").slice(0, 3);
  return <section className="pc-journal card"><header><Icon name="logs" /><strong>Операции</strong>{active ? <Pill tone="accent">В работе: {active}</Pill> : <span className="pve-muted">{tasks.length ? statuses[tasks[0].status] : ""}</span>}<button type="button" className="pve-btn ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Свернуть" : `Показать · ${tasks.length}`}</button></header>
    {error ? <div className="pc-error" role="alert">Журнал не обновлён: {error}<button type="button" className="pve-btn ghost" onClick={retry}>Повторить</button></div> : null}
    {expanded ? <p className="monitor-journal-hint">Последние 100 операций сохраняются между перезапусками. Незавершённые операции после перезапуска требуют проверки состояния.</p> : null}
    <div aria-live="polite">{visible.map((t) => <div key={t.id} className="pc-job"><Dot tone={t.status === "done" ? "ok" : t.status === "error" ? "bad" : t.status === "unknown" ? "warn" : "idle"} pulse={t.status === "running"} /><div><strong>{labels[t.action]} · {t.name || t.resource_id || t.host}</strong><span className="pve-muted">{t.host}{t.context ? ` · ${contextName(t.context)}` : ""}</span>{t.message ? <span>{t.message}</span> : null}{t.status === "unknown" ? <span>Проверьте состояние перед повторной отправкой.</span> : null}</div><span className="pc-job-state">{statuses[t.status]}<small>{ago(t.created_at)}</small></span></div>)}</div>
  </section>;
}

export function Management({ host, computers, enabled, reload, children }: { host: Host; computers: Computer[]; enabled: boolean; reload: () => void; children: ReactNode }) {
  const poll = usePcPoll<{ tasks: Task[] }>(host, enabled ? "/api/pc/tasks" : null, 4);
  const [local, setLocal] = useState<Task[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const known = new Map((poll.data?.tasks || []).map((t) => [t.id, t]));
  const tasks = [...known.values(), ...local.filter((t) => !known.has(t.id))].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    let changed = false;
    for (const t of poll.data?.tasks || []) {
      if (previous.current.has(t.id) && previous.current.get(t.id) !== t.status) changed = true;
      previous.current.set(t.id, t.status);
    }
    if (changed) reload();
  }, [poll.data, reload]);
  const pending = (target: Target) => tasks.some((t) => t.status === "running" && t.host === target.h.id && (target.c
    ? (t.target === "docker" && t.resource_id === target.c.id && t.context === target.context) || (t.target === "wsl" && target.context === `wsl:${t.name}`)
    : (t.target === "wsl" && t.name === target.w.name) || (t.target === "docker" && t.context === `wsl:${target.w.name}`)));
  const select = (next: Selection) => { setSelection(next); setError(""); setTyped(""); };
  const h = computers.find((x) => x.id === selection?.h.id);
  const c = selection?.c ? h?.current?.docker.find((d) => d.context === selection.context)?.containers.find((x) => x.id === selection.c?.id) : undefined;
  const w = selection?.w ? h?.current?.wsl.find((x) => x.name === selection.w?.name) : undefined;
  const live: Target | null = h && c && selection?.context ? { h, c, context: selection.context } : h && w ? { h, w } : null;
  const unavailable = !selection ? "" : !live ? "Объект больше не найден. Обновите страницу." : blocked(live) || (!allowed(live).includes(selection.action) ? "Состояние изменилось. Выберите доступное действие заново." : "");
  const expected = selection?.c?.name || selection?.w?.name || "";
  const requiresTyped = selection?.action === "terminate";
  const send = async () => {
    if (!selection || !live || unavailable || busy || (requiresTyped && typed !== expected)) return;
    const body: ActionRequest = live.c ? { host: live.h.id, target: "docker", context: live.context, id: live.c.id, action: selection.action, confirm: live.c.name }
      : { host: live.h.id, target: "wsl", name: live.w.name, action: selection.action, confirm: live.w.name };
    setBusy(true); setError("");
    try {
      const { task } = await (await host.api("/api/pc/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as { task: Task };
      setLocal((old) => [task, ...old].slice(0, 20)); setSelection(null);
      host.notify(task.status === "error" ? "Операция завершилась ошибкой. Подробности в журнале." : task.status === "unknown" ? "Результат неизвестен. Проверьте состояние компьютера." : task.status === "done" ? "Операция выполнена." : "Команда отправлена. Результат появится в журнале операций.");
      void poll.reload(); reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <Context.Provider value={{ select, pending }}>
    <Journal tasks={tasks} error={poll.error} retry={() => void poll.reload()} />{children}
    <Modal open={!!selection} title={selection ? `${labels[selection.action]}?` : "Управление"} onClose={() => setSelection(null)} locked={busy} size="sm"
      footer={<><button type="button" className="btn" onClick={() => setSelection(null)} disabled={busy}>Отмена</button><button type="button" className={`btn ${selection?.action === "start" ? "btn-primary" : "btn-danger"}`} disabled={busy || !!unavailable || !!(live && pending(live)) || (requiresTyped && typed !== expected)} onClick={() => void send()}>{busy ? "Отправляю…" : selection ? labels[selection.action] : "Продолжить"}</button></>}>
      {selection ? <div className="pc-confirm"><div className="pc-confirm-target"><Icon name={selection.c ? "dms" : "terminal"} size={24} /><div><strong>{expected}</strong><span>{selection.h.name}{selection.context ? ` · ${contextName(selection.context)}` : " · WSL"}</span></div></div>
        <p>{selection.action === "terminate" ? "Будут завершены все процессы внутри этого дистрибутива, включая Docker и его контейнеры. Несохранённые данные могут быть потеряны."
          : selection.action === "stop" ? "Контейнер получит запрос на остановку. Его сервисы станут недоступны до следующего запуска."
          : selection.action === "restart" ? "Контейнер будет остановлен и запущен снова. Его сервисы временно станут недоступны."
          : selection.w ? "Дистрибутив WSL будет запущен. Пока он работает, HomeNet проверяет Docker внутри него. При отсутствии активных процессов WSL может автоматически остановиться." : "Контейнер будет запущен с текущими настройками."}</p>
        {requiresTyped ? <label>Введите имя <b>{expected}</b> для подтверждения<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label> : null}
        {unavailable || error ? <div className="pc-error" role="alert">{unavailable || error}</div> : null}
      </div> : null}
    </Modal>
  </Context.Provider>;
}
