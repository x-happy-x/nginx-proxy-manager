import type { CertItem, SslMode } from "../../../types";
import "./CertsTab.scss";
import { Button, FieldLabel, Panel, RadioChips, UiIcon } from "../../ui";
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
      <div className="certs-overview-grid">
        <Panel className="panel cert-policy-card">
          <div className="section-title-block">
            <span className="section-icon"><UiIcon name="cert" /></span>
            <div><h2>{t("certs.title")}</h2><p>Политика выпуска для новых маршрутов</p></div>
          </div>
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

        <Panel className="panel ca-status-card">
          <div className="ca-status-head">
            <span className={`ca-status-icon ${caInstalled ? "installed" : "missing"}`}><UiIcon name="key" /></span>
            <div>
              <span className="eyebrow">{t("certs.local_ca")}</span>
              <h2>{caInstalled ? "Центр сертификации готов" : "Центр сертификации не настроен"}</h2>
              <p>{caInstalled ? "Можно выпускать доверенные сертификаты для локальных доменов." : "Создайте или загрузите CA перед выпуском сертификатов."}</p>
            </div>
          </div>
          <div className="actions-row">
            <Button iconName="cert" onClick={onOpenCaModal} disabled={busy}>{t("certs.manage_ca")}</Button>
            <Button iconName="download" onClick={onDownloadCa} disabled={busy || !caInstalled}>{t("certs.download_ca")}</Button>
            <Button variant="accent" iconName="bolt" onClick={onIssueCa} disabled={busy || !caInstalled}>{t("certs.issue_routes")}</Button>
          </div>
        </Panel>
      </div>

      <Panel className="panel">
        <div className="section-head">
          <div className="section-title-block">
            <span className="section-icon"><UiIcon name="cert" /></span>
            <div><h2>{t("certs.certificates")}</h2><p>{certs.length} сертификатов на прокси</p></div>
          </div>
          <Button iconName="refresh" onClick={onRefreshCerts} disabled={busy}>{t("common.refresh")}</Button>
        </div>
        <div className="cert-grid">
          {certs.map((item) => (
            <div key={item.host} className="cert-card">
              <div className="cert-card-head">
                <span className="cert-card-icon"><UiIcon name="cert" /></span>
                <div><strong>{item.host}</strong><span className={`cert-state ${item.has_key ? "complete" : "partial"}`}>{item.has_key ? t("certs.crt_key") : t("certs.crt_only")}</span></div>
              </div>
              <p className="mono" title={item.path}>{item.path}</p>
              <div className="cert-actions">
                <Button compact iconName="test" onClick={() => onTestCert(item.host)}>{t("common.test")}</Button>
                <Button compact iconName="download" onClick={() => onDownloadCert(item.host, "crt")}>{t("certs.crt")}</Button>
                <Button compact iconName="key" onClick={() => onDownloadCert(item.host, "key")} disabled={!item.has_key}>{t("certs.key")}</Button>
                <Button compact iconName="trash" className="cert-delete" onClick={() => onDeleteCert(item.host)} aria-label={`${t("common.delete")}: ${item.host}`}>{t("common.delete")}</Button>
              </div>
            </div>
          ))}
          {certs.length === 0 && <div className="cert-empty"><UiIcon name="cert" /><strong>Сертификатов пока нет</strong><span>Они появятся после выпуска для настроенных маршрутов.</span></div>}
        </div>
      </Panel>
    </section>
  );
}
