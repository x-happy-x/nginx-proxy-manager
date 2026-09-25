import { useState } from "react";
import type { CertItem, SslMode } from "../types";
import { Icon } from "../components/ui/Icon";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { EmptyState, Field, SearchInput, Segmented } from "../components/ui/controls";
import { PageHeader } from "../navigation";

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

const MODE_HINTS: Record<SslMode, string> = {
  acme: "Сертификаты Let's Encrypt. Нужен публичный доступ к домену и email.",
  "local-ca": "Сертификаты подписывает локальный центр сертификации. Установите его корневой сертификат на устройства.",
  "self-signed": "Самоподписанные сертификаты: браузеры будут предупреждать о недоверенном соединении.",
  off: "TLS не используется, маршруты работают только по HTTP.",
};

export function Certs({
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
  const [query, setQuery] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const rows = certs.filter((item) => !needle || item.host.toLowerCase().includes(needle));

  return (
    <div className="stack">
      <PageHeader
        page="certs"
        actions={
          <button type="button" className="btn" onClick={onRefreshCerts} disabled={busy}>
            <Icon name="refresh" />
            Обновить
          </button>
        }
      />

      <div className="grid-2">
        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Политика TLS</h2>
              <p>Как выпускаются сертификаты для новых маршрутов</p>
            </div>
          </div>
          <div className="card-body stack">
            <Segmented
              label="Тип подписи"
              value={sslMode}
              onChange={onSslMode}
              options={[
                { value: "local-ca", label: "Локальный CA" },
                { value: "acme", label: "ACME" },
                { value: "self-signed", label: "Самоподписанные" },
                { value: "off", label: "Только HTTP" },
              ]}
            />
            <p className="field-hint">{MODE_HINTS[sslMode]}</p>
            {sslMode === "acme" ? (
              <Field label="Email для Let's Encrypt">
                <input
                  type="email"
                  value={acmeEmail}
                  placeholder="admin@example.com"
                  onChange={(e) => onAcmeEmail(e.target.value)}
                />
              </Field>
            ) : null}
            <p className="field-hint">
              Политика хранится в черновике маршрутов: сохраните и примените его.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div className="card-title">
              <h2>Локальный центр сертификации</h2>
              <p>Корневой сертификат для доверенного HTTPS в домашней сети</p>
            </div>
            {caInstalled ? (
              <span className="badge badge-success">
                <Icon name="check" /> Настроен
              </span>
            ) : (
              <span className="badge badge-warning">
                <Icon name="alert" /> Не настроен
              </span>
            )}
          </div>
          <div className="card-body stack">
            <p className="secondary">
              {caInstalled
                ? "Можно выпускать доверенные сертификаты для локальных доменов. Установите корневой сертификат CA на устройства, чтобы браузеры доверяли им."
                : "Создайте новый CA или загрузите существующий, прежде чем выпускать сертификаты."}
            </p>
            {caInstalled ? (
              <div className="button-row">
                <button type="button" className="btn btn-primary" onClick={onIssueCa} disabled={busy}>
                  <Icon name="bolt" />
                  Выпустить для маршрутов
                </button>
                <button type="button" className="btn" onClick={onDownloadCa} disabled={busy}>
                  <Icon name="download" />
                  Скачать ca.crt
                </button>
                <button type="button" className="btn btn-ghost" onClick={onOpenCaModal} disabled={busy}>
                  <Icon name="key" />
                  Заменить CA
                </button>
              </div>
            ) : (
              <div className="button-row">
                <button type="button" className="btn btn-primary" onClick={onOpenCaModal} disabled={busy}>
                  <Icon name="key" />
                  Настроить CA
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="card card-flush">
        <div className="card-header">
          <div className="card-title">
            <h2>
              Сертификаты на прокси<span className="count">{certs.length}</span>
            </h2>
            <p>Файлы, которые использует выделенный nginx</p>
          </div>
          {certs.length > 6 ? (
            <SearchInput label="Поиск сертификата" placeholder="Домен" value={query} onChange={setQuery} />
          ) : null}
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Домен</th>
                  <th className="col-shrink">Файлы</th>
                  <th>Путь</th>
                  <th className="col-actions">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.host}>
                    <td className="cell-primary" data-label="">
                      <div className="cell-title">
                        <Icon name="certs" className="muted" />
                        <strong className="mono domain">{item.host}</strong>
                      </div>
                    </td>
                    <td className="cell-aside col-shrink">
                      {item.has_key ? (
                        <span className="badge badge-success">CRT + KEY</span>
                      ) : (
                        <span className="badge badge-warning">Только CRT</span>
                      )}
                    </td>
                    <td data-label="Путь" className="mono secondary break" title={item.path}>
                      {item.path}
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button type="button" className="btn btn-sm" onClick={() => onTestCert(item.host)} disabled={busy}>
                          <Icon name="activity" size={14} />
                          Проверить
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onDownloadCert(item.host, "crt")}>
                          <Icon name="download" size={14} />
                          CRT
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onDownloadCert(item.host, "key")}
                          disabled={!item.has_key}
                        >
                          <Icon name="key" size={14} />
                          KEY
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-icon btn-danger-ghost"
                          aria-label={`Удалить сертификат ${item.host}`}
                          title="Удалить сертификат"
                          onClick={() => setRemove(item.host)}
                          disabled={busy}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="certs" title={certs.length ? "Ничего не найдено" : "Сертификатов пока нет"}>
            {certs.length
              ? "Измените запрос."
              : "Они появятся после выпуска для настроенных маршрутов."}
          </EmptyState>
        )}
      </section>

      <ConfirmDialog
        open={!!remove}
        title="Удалить сертификат?"
        confirmLabel="Удалить с прокси"
        busy={busy}
        onClose={() => setRemove(null)}
        onConfirm={() => {
          if (remove) onDeleteCert(remove);
          setRemove(null);
        }}
      >
        Файлы сертификата <strong className="mono">{remove}</strong> будут удалены с роутера
        сразу. Маршрут, который их использует, перестанет работать по HTTPS до повторного
        выпуска.
      </ConfirmDialog>
    </div>
  );
}
