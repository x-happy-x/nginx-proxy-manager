import type { CertItem, SslMode } from "../../../types";
import "./CertsTab.scss";
import { Button, CardIconActions, FieldLabel, Panel, RadioChips } from "../../ui";
import { useI18n } from "../../../i18n";

type Props = {
  busy: boolean;
  sslMode: SslMode;
  acmeEmail: string;
  caInstalled: boolean;
  certs: CertItem[];
  onSslMode: (value: SslMode) => void;
  onAcmeEmail: (value: string) => void;
  onOpenCaModal: () => void;
  onDownloadCa: () => void;
  onRefreshCerts: () => void;
  onDeleteCert: (host: string) => void;
  onTestCert: (host: string) => void;
  onDownloadCert: (host: string, kind: "crt" | "key") => void;
  onIssueCa: () => void;
};

export function CertsTab({
  busy,
  sslMode,
  acmeEmail,
  caInstalled,
  certs,
  onSslMode,
  onAcmeEmail,
  onOpenCaModal,
  onDownloadCa,
  onRefreshCerts,
  onDeleteCert,
  onTestCert,
  onDownloadCert,
  onIssueCa,
}: Props) {
  const { t } = useI18n();
  return (
    <section className="tab-section certs-tab">
      <Panel className="panel">
        <h2>{t("certs.title")}</h2>
        <FieldLabel text={t("certs.signature_type")}>
          <RadioChips
            value={sslMode}
            onChange={onSslMode}
            options={[
              { value: "acme", label: t("certs.mode_acme") },
              { value: "local-ca", label: t("certs.mode_local_ca") },
              { value: "self-signed", label: t("certs.mode_self_signed") },
              { value: "off", label: t("certs.mode_http_only") },
            ]}
          />
        </FieldLabel>
        {sslMode === "acme" ? (
          <FieldLabel text={t("certs.acme_email")}>
            <input type="email" value={acmeEmail} onChange={(e) => onAcmeEmail(e.target.value)} />
          </FieldLabel>
        ) : null}
      </Panel>

      <Panel className="panel">
        <h2>{t("certs.local_ca")}</h2>
        <p>{t("common.status")}: <b>{caInstalled ? t("certs.installed") : t("certs.missing")}</b></p>
        <div className="actions-row">
          <Button iconName="cert" onClick={onOpenCaModal} disabled={busy}>{t("certs.manage_ca")}</Button>
          <Button iconName="download" onClick={onDownloadCa} disabled={busy}>{t("certs.download_ca")}</Button>
          <Button iconName="bolt" onClick={onIssueCa} disabled={busy || !caInstalled}>{t("certs.issue_routes")}</Button>
        </div>
      </Panel>

      <Panel className="panel">
        <div className="section-head">
          <h2>{t("certs.certificates")}</h2>
          <Button iconName="refresh" onClick={onRefreshCerts} disabled={busy}>{t("common.refresh")}</Button>
        </div>
        <div className="cert-grid">
          {certs.map((item) => (
            <div key={item.host} className="cert-card">
              <strong>{item.host}</strong>
              <p className="mono">{item.path}</p>
              <p>{item.has_key ? t("certs.crt_key") : t("certs.crt_only")}</p>
              <div className="actions-row">
                <CardIconActions
                  actions={[
                    { iconName: "test", tooltip: t("common.test"), onClick: () => onTestCert(item.host) },
                    { iconName: "download", tooltip: t("certs.crt"), onClick: () => onDownloadCert(item.host, "crt") },
                    { iconName: "key", tooltip: t("certs.key"), onClick: () => onDownloadCert(item.host, "key") },
                    { iconName: "trash", tooltip: t("common.delete"), onClick: () => onDeleteCert(item.host) },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}
