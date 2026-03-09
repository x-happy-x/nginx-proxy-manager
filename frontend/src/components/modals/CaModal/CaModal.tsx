import { useState } from "react";
import "./CaModal.scss";
import { Button, FieldLabel, ModalShell, RadioChips } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onUpload: (cert: string, key: string) => void;
  onGenerate: (subject: Record<string, string>) => void;
};

export function CaModal({ open, busy, onClose, onUpload, onGenerate }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"create" | "upload">("create");
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [subject, setSubject] = useState<Record<string, string>>({ C: "", ST: "", L: "", O: "", CN: "Local Dev Root CA" });

  return (
    <ModalShell open={open} onClose={onClose}>
        <header>
          <h3>{t("modal.ca.title")}</h3>
          <Button iconName="close" onClick={onClose} compact>{t("common.close")}</Button>
        </header>
        <div className="tabs-inline">
          <RadioChips
            value={tab}
            onChange={setTab}
            options={[
              { value: "create", label: t("modal.ca.create") },
              { value: "upload", label: t("modal.ca.upload") },
            ]}
          />
        </div>
        {tab === "create" ? (
          <div className="grid-2">
            {[
              ["C", t("modal.ca.country")],
              ["ST", t("modal.ca.state")],
              ["L", t("modal.ca.city")],
              ["O", t("modal.ca.org")],
              ["CN", t("modal.ca.cn")],
            ].map(([key, label]) => (
              <FieldLabel key={key} text={label}>
                <input value={subject[key] || ""} onChange={(e) => setSubject((prev) => ({ ...prev, [key]: e.target.value }))} />
              </FieldLabel>
            ))}
            <Button iconName="cert" variant="accent" disabled={busy} onClick={() => onGenerate(subject)}>{t("modal.ca.generate")}</Button>
          </div>
        ) : (
          <div className="grid-1">
            <FieldLabel text={t("modal.ca.ca_cert")}>
              <textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
            </FieldLabel>
            <FieldLabel text={t("modal.ca.ca_key")}>
              <textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
            </FieldLabel>
            <Button iconName="upload" variant="accent" disabled={busy} onClick={() => onUpload(certPem, keyPem)}>{t("common.upload")}</Button>
          </div>
        )}
    </ModalShell>
  );
}
