import { useRef } from "react";
import type { RoutesDocument } from "../../../types";
import { useI18n } from "../../../i18n";
import { CheckboxChip, FieldLabel, IconButton, Panel } from "../../../components/ui";

type Props = {
  doc: RoutesDocument;
  busy: boolean;
  onApplyStub: () => void;
  onRestartUi: () => void;
  onUploadStub: (content: string) => void;
  onSetGlobal: (patch: Partial<RoutesDocument["globals"]>) => void;
};

export function StubSettingsPanel({ doc, busy, onApplyStub, onRestartUi, onUploadStub, onSetGlobal }: Props) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <div className="section-head">
        <h2>{t("servers.listen_stub")}</h2>
        <IconButton iconName="bolt" iconOnly tooltip={t("servers.apply_stub")} onClick={onApplyStub} disabled={busy} />
      </div>
      <Panel className="panel">
        <FieldLabel text={t("servers.listen_ips")}>
          <input value={doc.globals.listen_ips.join(", ")} onChange={(e) => onSetGlobal({ listen_ips: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} />
        </FieldLabel>
        <div className="row-2">
          <FieldLabel text={t("servers.http")}>
            <input type="number" value={doc.globals.ports.http} onChange={(e) => onSetGlobal({ ports: { ...doc.globals.ports, http: Number(e.target.value) || 80 } })} />
          </FieldLabel>
          <FieldLabel text={t("servers.https")}>
            <input type="number" value={doc.globals.ports.https} onChange={(e) => onSetGlobal({ ports: { ...doc.globals.ports, https: Number(e.target.value) || 443 } })} />
          </FieldLabel>
        </div>
        <div className="row-2">
          <FieldLabel text={t("servers.extra_http")}>
            <input
              value={doc.globals.ports.http_extra.join(", ")}
              onChange={(e) =>
                onSetGlobal({
                  ports: {
                    ...doc.globals.ports,
                    http_extra: e.target.value.split(",").map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0 && v <= 65535),
                  },
                })
              }
            />
          </FieldLabel>
          <FieldLabel text={t("servers.extra_https")}>
            <input
              value={doc.globals.ports.https_extra.join(", ")}
              onChange={(e) =>
                onSetGlobal({
                  ports: {
                    ...doc.globals.ports,
                    https_extra: e.target.value.split(",").map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0 && v <= 65535),
                  },
                })
              }
            />
          </FieldLabel>
        </div>
        <div className="row-2">
          <FieldLabel text={t("servers.ui_host")}>
            <input value={doc.globals.ui.host} onChange={(e) => onSetGlobal({ ui: { ...doc.globals.ui, host: e.target.value } })} />
          </FieldLabel>
          <FieldLabel text={t("servers.ui_port")}>
            <input type="number" value={doc.globals.ui.port} onChange={(e) => onSetGlobal({ ui: { ...doc.globals.ui, port: Number(e.target.value) || 8080 } })} />
          </FieldLabel>
        </div>
        <div className="toggle-row">
          <CheckboxChip checked={doc.globals.stub.enabled} onChange={(next) => onSetGlobal({ stub: { ...doc.globals.stub, enabled: next } })} label={t("servers.enable_stub")} />
        </div>
        <div className="actions-row">
          <IconButton iconName="refresh" iconOnly tooltip={t("servers.restart_ui")} onClick={onRestartUi} disabled={busy} />
          <input
            ref={fileRef}
            type="file"
            accept=".html,.htm,.txt"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              onUploadStub(await file.text());
              e.currentTarget.value = "";
            }}
          />
          <IconButton iconName="upload" iconOnly tooltip={t("servers.upload_stub")} onClick={() => fileRef.current?.click()} disabled={busy} />
        </div>
      </Panel>
    </>
  );
}
