import { useState } from "react";
import { Modal } from "../../components/ui/Modal";
import { Icon } from "../../components/ui/Icon";
import type { Computer } from "./model";
import { usePc } from "./context";

export function ComputerPower({ h }: { h: Computer }) {
  const { host } = usePc();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!h.power?.enabled) return null;
  const send = async (action: "start" | "shutdown") => {
    setBusy(true); setError("");
    try {
      const response = await host.api("/api/pc/actions", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: h.id, target: "power", action, confirm: h.name }) });
      if (!response.ok) throw new Error((await response.json()).error || "Команда не принята");
      setConfirm(false);
      host.notify(action === "start" ? "Запрос на включение отправлен. Дождитесь появления компьютера в сети." : "Запрос на штатное выключение отправлен. Результат появится в журнале.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="pc-controls"><div className="pc-button-row">
    <button type="button" className="pve-btn" disabled={busy || h.power.busy || h.power.state === "on" || !h.power.actions.includes("start")} onClick={() => void send("start")}><Icon name="play" size={14} />Включить</button>
    <button type="button" className="pve-btn" disabled={busy || h.power.busy || !h.power.actions.includes("shutdown")} onClick={() => { setConfirm(true); setError(""); }} title={!h.power.actions.includes("shutdown") ? "Нужен доступный агент с разрешением выключать компьютер" : "Штатное выключение компьютера"}><Icon name="stop" size={14} />Выключить</button>
  </div>{error && !confirm ? <p className="pc-error" role="alert">{error}</p> : null}
    <Modal open={confirm} title={`Выключить ${h.name}?`} onClose={() => setConfirm(false)} locked={busy} size="sm"
      footer={<><button type="button" className="btn" onClick={() => setConfirm(false)} disabled={busy}>Отмена</button><button type="button" className="btn btn-danger" disabled={busy || !h.power.actions.includes("shutdown")} onClick={() => void send("shutdown")}>{busy ? "Отправляю…" : "Выключить"}</button></>}>
      <p>Компьютер получит запрос на штатное завершение работы. Сохраните открытые документы. Питание розетки останется включённым.</p>
      {error ? <p className="pc-error" role="alert">{error}</p> : null}
    </Modal>
  </div>;
}
