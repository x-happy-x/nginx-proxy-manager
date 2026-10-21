import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import type { Host } from "../../platform/sdk";
import { ago, guestStatus, running, stale, taskPending, useTasks, type PveAction, type PveGuest, type PveHost, type PveTask } from "./model";
import { Dot, Pill } from "./parts";

const ACTIONS: Record<PveAction, { label: string; icon: IconName }> = {
  start: { label: "Запустить", icon: "play" }, shutdown: { label: "Выключить", icon: "bolt" },
  reboot: { label: "Перезагрузить", icon: "refresh" }, stop: { label: "Остановить принудительно", icon: "alert" },
  resume: { label: "Продолжить", icon: "play" },
};
type Selection = { host: PveHost; guest?: PveGuest; action: PveAction };
type Controls = { choose: (h: PveHost, action: PveAction, g?: PveGuest) => void; pending: (h: PveHost, g?: PveGuest) => boolean };
const Context = createContext<Controls>({ choose: () => undefined, pending: () => false });

function reason(h: PveHost, g?: PveGuest): string {
  if (!h.online) return "Сервер не отвечает. Управление станет доступно после восстановления связи.";
  if (stale(h)) return "Данные устарели. Дождитесь свежего состояния сервера.";
  if (!h.capabilities?.control) return "Управление не разрешено. Обновите агент и включите нужные разрешения по инструкции в настройках.";
  if (g?.template) return "Шаблоны не запускаются. Создайте машину из шаблона в Proxmox.";
  if (g?.lock) return `Машина занята: ${g.lock}. Дождитесь завершения операции.`;
  return "";
}

function availableActions(h: PveHost, g?: PveGuest): PveAction[] {
  const permitted = g ? h.capabilities?.guest_actions || [] : h.capabilities?.node_actions || [];
  const actions: PveAction[] = g
    ? g.status === "running" ? ["shutdown", "reboot", "stop"] : g.status === "paused" || g.status === "suspended" ? ["resume", "stop"] : g.status === "stopped" ? ["start"] : []
    : ["reboot", "shutdown"];
  return actions.filter((a) => permitted.includes(a));
}

export function ActionButtons({ h, g, compact = false, onAction }: { h: PveHost; g?: PveGuest; compact?: boolean; onAction?: () => void }) {
  const { choose, pending } = useContext(Context);
  const blocked = reason(h, g);
  const busy = pending(h, g);
  let actions = availableActions(h, g);
  if (compact) actions = actions.slice(0, 1);
  return <div className="pve-control">
    <div className="pve-action-buttons">
      {actions.map((action) => <button key={action} type="button" className={`pve-btn${action === "start" || action === "resume" ? " primary" : action === "stop" ? " danger ghost" : ""}`}
        disabled={!!blocked || busy} title={blocked || (busy ? "Операция уже выполняется" : undefined)}
        onClick={() => { onAction?.(); choose(h, action, g); }}><Icon name={busy ? "clock" : ACTIONS[action].icon} size={14} />{busy ? "Выполняется…" : ACTIONS[action].label}</button>)}
    </div>
    {!compact && blocked ? <p className="pve-control-note"><Icon name="lock" size={13} />{blocked}</p> : null}
    {!compact && !blocked && !actions.length ? <p className="pve-control-note">{g ? `Для состояния «${guestStatus(g)}» агент не предлагает действий.` : "Управление питанием сервера не разрешено. Включите его при установке агента."}</p> : null}
  </div>;
}

const TASK_STATUS: Record<PveTask["status"], string> = { running: "Выполняется", accepted: "Команда принята", done: "Выполнено", error: "Ошибка", unknown: "Результат неизвестен" };

function TaskJournal({ tasks, hosts, error, reload }: { tasks: PveTask[]; hosts: PveHost[]; error: string; reload: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const active = tasks.filter(taskPending);
  if (!tasks.length && !error) return null;
  const visible = expanded ? tasks.slice(0, 20) : tasks.filter((t) => taskPending(t) || t.status === "unknown" || t.status === "error").slice(0, 3);
  return <section className="pve-tasks card" aria-label="Операции Proxmox">
    <header className="pve-tasks-head">
      <Icon name="logs" /> <strong>Операции</strong>
      {active.length ? <Pill tone="accent">В работе: {active.length}</Pill> : <span className="pve-muted pve-small">{tasks.length ? `Последняя: ${TASK_STATUS[tasks[0].status].toLowerCase()}` : "Журнал недоступен"}</span>}
      <button type="button" className="pve-btn ghost" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Свернуть" : `Показать${tasks.length ? ` · ${tasks.length}` : ""}`}</button>
    </header>
    {error ? <div className="pve-task-error" role="alert">Не удалось обновить операции: {error} <button type="button" className="pve-btn ghost" onClick={reload}>Повторить</button></div> : null}
    {expanded ? <p className="monitor-journal-hint">Последние 100 операций сохраняются между перезапусками. Незавершённые операции после перезапуска требуют проверки состояния.</p> : null}
    <div aria-live="polite" aria-relevant="additions text">
      {visible.map((t) => <div className="pve-task" key={t.id}>
        <Dot tone={t.status === "done" ? "ok" : t.status === "error" ? "bad" : t.status === "unknown" ? "warn" : "idle"} pulse={taskPending(t)} />
        <div className="pve-task-main"><strong>{ACTIONS[t.action]?.label || t.action} · {hosts.find((h) => h.id === t.host)?.name || t.host}{t.target === "guest" ? ` / ${t.type === "lxc" ? "CT" : "VM"} ${t.vmid}` : ""}</strong>
          {t.message ? <span className="pve-muted">{t.message}</span> : null}
          {t.status === "accepted" ? <span className="pve-muted">Сервер принял команду. Проверяйте его состояние в обзоре.</span> : null}
          {t.status === "unknown" ? <span className="pve-muted">Проверьте состояние в Proxmox перед повторной отправкой.</span> : null}
        </div>
        <span className={`pve-task-status tone-text-${t.status === "error" ? "bad" : t.status === "done" ? "ok" : "idle"}`}>{TASK_STATUS[t.status]}<small>{ago(t.created_at)}</small></span>
      </div>)}
    </div>
  </section>;
}

export function Management({ host, hosts, enabled, onRefresh, children }: { host: Host; hosts: PveHost[]; enabled: boolean; onRefresh: () => void; children: ReactNode }) {
  const poll = useTasks(host, enabled);
  const [submitted, setSubmitted] = useState<PveTask[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const known = new Map((poll.data?.tasks || []).map((t) => [t.id, t]));
  const tasks = [...known.values(), ...submitted.filter((t) => !known.has(t.id))].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const previous = useRef(new Map<string, string>());
  useEffect(() => {
    let changed = false;
    for (const t of poll.data?.tasks || []) {
      if (previous.current.has(t.id) && previous.current.get(t.id) !== t.status) changed = true;
      previous.current.set(t.id, t.status);
    }
    if (changed) onRefresh();
  }, [poll.data, onRefresh]);
  const pending = (h: PveHost, g?: PveGuest) => tasks.some((t) => taskPending(t) && t.host === h.id && (t.target === "node" || !g || t.vmid === g.vmid));
  const choose = (h: PveHost, action: PveAction, g?: PveGuest) => { setSelection({ host: h, guest: g, action }); setTyped(""); setError(""); };
  // Re-check live state while the confirmation is open; never submit a stale snapshot.
  const liveHost = hosts.find((h) => h.id === selection?.host.id);
  const liveGuest = selection?.guest ? liveHost?.current?.guests.find((g) => g.vmid === selection.guest?.vmid && g.type === selection.guest.type) : undefined;
  const unavailable = selection ? !liveHost ? "Сервер удалён из настроек." : selection.guest && !liveGuest ? "Машина больше не найдена на этом сервере." : reason(liveHost, liveGuest) || (!availableActions(liveHost, liveGuest).includes(selection.action) ? "Состояние или разрешения изменились. Закройте окно и выберите доступное действие." : "") : "";
  const typedRequired = !!selection && (!selection.guest || selection.action === "stop");
  const expected = selection?.guest ? String(selection.guest.vmid) : selection?.host.id || "";
  const send = async () => {
    if (!selection || !liveHost || unavailable || busy || (typedRequired && typed !== expected)) return;
    setBusy(true); setError("");
    try {
      const result = await (await host.api("/api/pve/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        host: liveHost.id, target: liveGuest ? "guest" : "node", type: liveGuest?.type, vmid: liveGuest?.vmid,
        action: selection.action, confirm: expected,
      }) })).json() as { task: PveTask };
      setSubmitted((old) => [result.task, ...old].slice(0, 20));
      setSelection(null);
      host.notify(result.task.status === "error" ? `Операция завершилась ошибкой: ${result.task.message || "см. журнал"}` : result.task.status === "unknown" ? "Результат операции неизвестен. Проверьте состояние в Proxmox." : result.task.status === "done" ? "Операция выполнена." : "Команда принята. Результат появится в журнале операций.");
      void poll.reload(); onRefresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <Context.Provider value={{ choose, pending }}>
    <TaskJournal tasks={tasks} hosts={hosts} error={poll.error} reload={() => void poll.reload()} />
    {children}
    <Modal open={!!selection} onClose={() => setSelection(null)} locked={busy} size="sm"
      title={selection ? `${ACTIONS[selection.action].label} ${selection.guest ? "машину" : "сервер"}?` : "Управление"}
      footer={<><button type="button" className="btn" disabled={busy} onClick={() => setSelection(null)}>Отмена</button><button type="button" className={`btn ${selection?.action === "start" || selection?.action === "resume" ? "btn-primary" : "btn-danger"}`}
        disabled={busy || !!unavailable || !!(liveHost && pending(liveHost, liveGuest)) || (typedRequired && typed !== expected)} onClick={() => void send()}>{busy ? "Отправляю…" : selection ? ACTIONS[selection.action].label : "Продолжить"}</button></>}>
      {selection ? <div className="pve-confirm">
        <div className="pve-confirm-target"><Icon name={selection.guest ? "layers" : "servers"} size={24} /><div><strong>{selection.guest?.name || selection.host.name}</strong><span>{selection.host.name}{selection.guest ? ` · ${selection.guest.type === "qemu" ? "VM" : "CT"} ${selection.guest.vmid}` : ` · ${selection.host.address}`}</span></div></div>
        <p>{!selection.guest ? `Это затронет весь сервер и его машины (запущено: ${running(liveHost?.current || null)}). ${selection.action === "shutdown" ? "Для включения потребуется физический доступ или отдельное управление питанием." : "Во время перезагрузки сервисы будут недоступны."}`
          : selection.action === "stop" ? "Принудительная остановка аналогична отключению питания. Несохранённые данные могут быть потеряны. Сначала попробуйте обычное выключение."
          : selection.action === "shutdown" ? "Гостевая система получит запрос на корректное завершение работы. Дождитесь результата операции."
          : selection.action === "reboot" ? "Машина перезагрузится. Её сервисы временно станут недоступны."
          : selection.action === "resume" ? "Выполнение приостановленной машины будет продолжено." : "Машина будет запущена с текущими настройками."}</p>
        {typedRequired ? <label className="pve-confirm-field">Введите {selection.guest ? "VMID" : "ID сервера"} <b>{expected}</b> для подтверждения<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label> : null}
        {unavailable || error ? <div className="pve-task-error" role="alert">{unavailable || error}</div> : null}
      </div> : null}
    </Modal>
  </Context.Provider>;
}
