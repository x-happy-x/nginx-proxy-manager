import { useState } from "react";
import type { RouteLogItem } from "../types";
import { Icon } from "../components/ui/Icon";
import { Modal } from "../components/ui/Modal";
import { EmptyState, SearchInput, Segmented } from "../components/ui/controls";
import { bytes, dateTime, ms, number, shortDate, timeOf } from "../lib/format";
import { PageHeader } from "../navigation";

export type LogMode = "all" | "4xx" | "5xx" | "errors";
type Source = "" | "local" | "external" | "unknown";

const str = (value: unknown) =>
  value == null || value === "" || value === "-" ? "" : String(value);

function statusClass(status: number): string {
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  if (status >= 300) return "redirect";
  return "";
}

function StatusCode({ value }: { value: unknown }) {
  const status = Number(value);
  return (
    <span className={`status-code ${statusClass(status)}`}>{str(value) || "—"}</span>
  );
}

function SourceBadge({ traffic }: { traffic: unknown }) {
  if (traffic === "external")
    return (
      <span className="badge badge-accent">
        <Icon name="globe" /> Внешний
      </span>
    );
  if (traffic === "local")
    return (
      <span className="badge">
        <Icon name="home" /> Локальный
      </span>
    );
  return <span className="badge">Не определён</span>;
}

const itemTime = (item: RouteLogItem) => item.time || item.time_local || item.timestamp;
const itemHost = (item: RouteLogItem) => str(item.route_host) || str(item.host) || "—";
const itemMethod = (item: RouteLogItem) =>
  str(item.method) || str(item.request_method) || "GET";
const itemLatency = (item: RouteLogItem) =>
  item.request_time_ms == null || item.request_time_ms === ""
    ? null
    : Number(item.request_time_ms);

export function RequestLog({
  items,
  filter,
  onFilter,
  mode,
  onMode,
  limit,
  onLimit,
  busy,
  onRefresh,
}: {
  items: RouteLogItem[];
  filter: string;
  onFilter: (value: string) => void;
  mode: LogMode;
  onMode: (mode: LogMode) => void;
  limit: number;
  onLimit: (value: number) => void;
  busy: boolean;
  onRefresh: () => void;
}) {
  const [source, setSource] = useState<Source>("");
  const [selected, setSelected] = useState<RouteLogItem | null>(null);
  const visible = items.filter(
    (item) => !source || String(item.traffic || "unknown") === source,
  );

  const download = () => {
    const blob = new Blob([visible.map((item) => JSON.stringify(item)).join("\n")], {
      type: "application/x-ndjson",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proxy-requests-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <PageHeader
        page="logs"
        actions={
          <>
            <button type="button" className="btn" onClick={download} disabled={!visible.length}>
              <Icon name="download" />
              Экспорт JSONL
            </button>
            <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="refresh" />}
              Обновить
            </button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput
          label="Поиск по журналу"
          placeholder="Домен, IP или путь — Enter для поиска"
          value={filter}
          onChange={onFilter}
          onSubmit={onRefresh}
        />
        <Segmented
          label="Статус"
          value={mode}
          onChange={onMode}
          options={[
            { value: "all", label: "Все" },
            { value: "4xx", label: "4xx" },
            { value: "5xx", label: "5xx" },
            { value: "errors", label: "Все ошибки" },
          ]}
        />
        <select
          aria-label="Источник запросов"
          value={source}
          onChange={(event) => setSource(event.target.value as Source)}
        >
          <option value="">Все источники</option>
          <option value="local">Локальные</option>
          <option value="external">Внешние</option>
          <option value="unknown">Не определён</option>
        </select>
        <select
          aria-label="Количество записей"
          value={limit}
          onChange={(event) => onLimit(+event.target.value)}
        >
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              {n} записей
            </option>
          ))}
        </select>
      </div>

      <section className="card card-flush">
        {visible.length ? (
          <div className="table-wrap log-table-wrap">
            <table className="table responsive request-table">
              <thead>
                <tr>
                  <th className="col-shrink">Время</th>
                  <th className="col-shrink">Статус</th>
                  <th>Запрос</th>
                  <th className="col-shrink">Источник</th>
                  <th className="req-upstream">Приложение</th>
                  <th className="col-num">Ответ</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item, i) => {
                  const latency = itemLatency(item);
                  return (
                    <tr
                      key={i}
                      className="clickable"
                      tabIndex={0}
                      onClick={() => setSelected(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(item);
                        }
                      }}
                    >
                      <td className="col-shrink req-time" data-label="">
                        <span className="mono">{timeOf(itemTime(item))}</span>
                        <span className="cell-sub">{shortDate(itemTime(item))}</span>
                      </td>
                      <td className="cell-aside col-shrink" data-label="">
                        <StatusCode value={item.status} />
                      </td>
                      <td className="cell-primary req-main" data-label="">
                        <strong className="break">{itemHost(item)}</strong>
                        <span className="cell-sub req-uri">
                          <span className="method">{itemMethod(item)}</span>
                          <span className="mono truncate">{str(item.uri) || "/"}</span>
                        </span>
                      </td>
                      <td className="col-shrink req-source" data-label="">
                        <SourceBadge traffic={item.traffic} />
                      </td>
                      <td className="mono secondary req-upstream" data-label="">
                        {str(item.upstream_addr) || "—"}
                      </td>
                      <td className="col-num mono req-latency" data-label="">
                        <span className={latency != null && latency >= 1000 ? "text-warning" : ""}>
                          {latency == null ? "—" : ms(latency)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="logs" title="Запросов не найдено">
            Измените фильтр или обновите журнал после обращения к сервису.
          </EmptyState>
        )}
        <div className="card-footer">
          Показано {number(visible.length)} из {number(items.length)} последних записей, новые
          сверху. Нажмите на строку, чтобы открыть подробности. Фильтр источника применяется к
          загруженной выборке.
        </div>
      </section>

      <RequestDetails item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function RequestDetails({
  item,
  onClose,
}: {
  item: RouteLogItem | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!item) return null;
  const latency = itemLatency(item);
  const rows: Array<[string, string]> = [
    ["Время", dateTime(itemTime(item))],
    ["Домен маршрута", str(item.route_host)],
    ["Заголовок Host", str(item.host)],
    ["Клиент", str(item.remote)],
    ["Вход", [str(item.scheme), str(item.server_addr) && `${str(item.server_addr)}:${str(item.server_port)}`, str(item.endpoint)].filter(Boolean).join(" · ")],
    ["Приложение", str(item.upstream_addr)],
    ["Статус приложения", str(item.upstream_status)],
    ["Время ответа", latency == null ? "" : ms(latency)],
    ["Подключение / заголовки", [str(item.upstream_connect_time), str(item.upstream_header_time)].filter(Boolean).map((v) => ms(Number(v) * 1000)).join(" / ")],
    ["Размер ответа", str(item.bytes_sent) ? bytes(Number(item.bytes_sent)) : ""],
    ["Размер запроса", str(item.request_length) ? bytes(Number(item.request_length)) : ""],
    ["User-Agent", str(item.http_user_agent)],
  ];
  const raw = JSON.stringify(item, null, 2);
  return (
    <Modal
      open
      variant="drawer"
      onClose={onClose}
      title={
        <span className="drawer-title">
          <StatusCode value={item.status} />
          <span className="method">{itemMethod(item)}</span>
          <span className="mono truncate">{str(item.uri) || "/"}</span>
        </span>
      }
      description={itemHost(item)}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(raw).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Icon name={copied ? "check" : "copy"} />
            {copied ? "Скопировано" : "Копировать JSON"}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Закрыть
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="button-row">
          <SourceBadge traffic={item.traffic} />
        </div>
        <dl className="kv">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={label === "User-Agent" ? "" : "mono"}>{value}</dd>
              </div>
            ))}
        </dl>
        <details className="raw-details">
          <summary>Исходная запись</summary>
          <pre className="code-block">{raw}</pre>
        </details>
      </div>
    </Modal>
  );
}
