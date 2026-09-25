import { useState } from "react";
import { Modal } from "./ui/Modal";
import { Field } from "./ui/controls";
import { Icon } from "./ui/Icon";

export function CaDialog({
  open,
  busy,
  onClose,
  onUpload,
  onGenerate,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onUpload: (cert: string, key: string) => void;
  onGenerate: (subject: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<"create" | "upload">("create");
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [subject, setSubject] = useState<Record<string, string>>({
    C: "",
    ST: "",
    L: "",
    O: "",
    CN: "Local Dev Root CA",
  });
  const fields: Array<[string, string, string]> = [
    ["CN", "Имя центра (CN)", "Local Dev Root CA"],
    ["O", "Организация", "HomeNet"],
    ["C", "Страна", "RU"],
    ["ST", "Регион", ""],
    ["L", "Город", ""],
  ];
  const canUpload = certPem.includes("BEGIN CERTIFICATE") && keyPem.includes("PRIVATE KEY");
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="lg"
      title="Локальный центр сертификации"
      description="Корневой сертификат подписывает сертификаты локальных доменов. Замена CA потребует заново установить его на устройства."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          {tab === "create" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !subject.CN?.trim()}
              onClick={() => onGenerate(subject)}
            >
              {busy ? <span className="spinner" /> : <Icon name="key" />}
              Создать CA
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !canUpload}
              onClick={() => onUpload(certPem, keyPem)}
            >
              {busy ? <span className="spinner" /> : <Icon name="upload" />}
              Загрузить CA
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "create"} onClick={() => setTab("create")}>
            Создать новый
          </button>
          <button type="button" role="tab" aria-selected={tab === "upload"} onClick={() => setTab("upload")}>
            Загрузить существующий
          </button>
        </div>
        {tab === "create" ? (
          <div className="form-grid">
            {fields.map(([key, label, placeholder]) => (
              <Field key={key} label={label} className={key === "CN" ? "span-2" : ""}>
                <input
                  value={subject[key] || ""}
                  placeholder={placeholder}
                  onChange={(e) => setSubject((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        ) : (
          <div className="stack">
            <Field label="Сертификат CA (PEM)">
              <textarea
                className="mono"
                rows={6}
                spellCheck={false}
                value={certPem}
                onChange={(e) => setCertPem(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----"
              />
            </Field>
            <Field label="Приватный ключ CA (PEM)" hint="Ключ передаётся только на роутер и не отображается повторно.">
              <textarea
                className="mono"
                rows={6}
                spellCheck={false}
                value={keyPem}
                onChange={(e) => setKeyPem(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----"
              />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ConfigEditorDialog({
  open,
  title,
  path,
  editable,
  content,
  busy,
  onClose,
  onChange,
  onSave,
}: {
  open: boolean;
  title: string;
  path: string;
  editable: boolean;
  content: string;
  busy: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const lines = content ? content.split("\n").length : 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="xl"
      title={
        <span className="dialog-title-row">
          {title || "Конфигурация"}
          <span className={`badge${editable ? " badge-warning" : ""}`}>
            {editable ? "Редактирование" : "Только чтение"}
          </span>
        </span>
      }
      description={<span className="mono">{path}</span>}
      footer={
        <>
          <span className="foot-note">{lines} строк</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {editable ? "Отмена" : "Закрыть"}
          </button>
          {editable ? (
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="save" />}
              Сохранить файл
            </button>
          ) : null}
        </>
      }
    >
      <textarea
        className="config-editor mono"
        spellCheck={false}
        value={content}
        onChange={(e) => onChange(e.target.value)}
        readOnly={!editable || busy}
        aria-label={`Содержимое ${path}`}
      />
    </Modal>
  );
}
