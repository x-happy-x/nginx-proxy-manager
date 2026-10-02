import type { ReactNode } from "react";
import { bytes } from "../../lib/format";
import type { MProxy } from "./api";
import { useMihomo } from "./context";
import { Alert, EmptyState } from "../../components/ui/controls";
import { Install } from "./Install";

export function speed(v: number | undefined): string {
  return `${bytes(v || 0)}/с`;
}

/** Last measured delay of a proxy; 0 means the last test failed. */
export function lastDelay(p: MProxy | undefined, testUrl?: string): number | null {
  if (!p) return null;
  const hist = (testUrl && p.extra?.[testUrl]?.history) || p.history || [];
  if (!hist.length) return null;
  return hist[hist.length - 1].delay;
}

export function delayTone(d: number | null): "good" | "warn" | "bad" | "none" {
  if (d == null) return "none";
  if (d <= 0) return "bad";
  if (d < 300) return "good";
  if (d < 800) return "warn";
  return "bad";
}

export function Delay({ value, testing }: { value: number | null; testing?: boolean }) {
  if (testing) return <span className="mh-delay is-testing"><span className="spinner" /></span>;
  const tone = delayTone(value);
  return (
    <span className={`mh-delay is-${tone}`} title={value == null ? "не проверялся" : value <= 0 ? "нет ответа" : `${value} мс`}>
      {value == null ? "—" : value <= 0 ? "нет ответа" : `${value} мс`}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: Array<[T, ReactNode]>; label: string }) {
  return (
    <div className="res-tabs" role="tablist" aria-label={label}>
      {items.map(([id, title]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={`res-tab${value === id ? " is-active" : ""}`} onClick={() => onChange(id)}>
          {title}
        </button>
      ))}
    </div>
  );
}

export function TabCount({ n }: { n: number }) {
  return <span className="mh-tab-count">{n}</span>;
}

/** Shown in place of every Mihomo page until the core runs. */
export function CoreGate({ children }: { children: ReactNode }) {
  const { status, statusError, refreshStatus } = useMihomo();
  if (!status) {
    return statusError ? (
      <Alert tone="danger" title="Менеджер не ответил о состоянии mihomo">{statusError}</Alert>
    ) : (
      <div className="launcher-loading">Проверяю mihomo…</div>
    );
  }
  if (!status.installed) return <Install />;
  if (!status.controller_ok) {
    return (
      <div className="stack">
        <Alert
          tone="warning"
          title="mihomo установлен, но контроллер не отвечает"
          action={
            <button type="button" className="btn" onClick={() => void refreshStatus()}>
              Проверить снова
            </button>
          }
        >
          Ожидается контроллер на {status.controller || "127.0.0.1:9090"}. Ответ: {status.error || "нет"}. Проверьте, что ядро запущено и в config.yaml задан external-controller.
        </Alert>
        <EmptyState icon="system" title="Нет связи с ядром">
          Бинарник: {status.binary}. Конфиг: {status.config}
          {status.config_exists ? "" : " (файла нет)"}.
        </EmptyState>
        <Install compact />
      </div>
    );
  }
  return <>{children}</>;
}

/** Tiny area chart of a series, scaled to its own max. */
export function Spark({ values, tone = "series-1", height = 36 }: { values: number[]; tone?: "series-1" | "series-2"; height?: number }) {
  const w = 120;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length < 2 ? w : (i / (values.length - 1)) * w, height - (v / max) * (height - 2) - 1]);
  if (!pts.length) return <svg className="mh-spark" viewBox={`0 0 ${w} ${height}`} aria-hidden="true" />;
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className={`mh-spark mh-${tone}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${w} ${height} L0 ${height}Z`} className="mh-spark-area" />
      <path d={line} className="mh-spark-line" />
    </svg>
  );
}

export function DeviceLabel({ ip }: { ip: string }) {
  const { deviceName } = useMihomo();
  const name = deviceName(ip);
  return name ? (
    <span className="mh-device" title={ip}>
      <strong>{name}</strong>
      <span className="cell-sub mono">{ip}</span>
    </span>
  ) : (
    <span className="mono">{ip}</span>
  );
}

export function Chain({ chains }: { chains: string[] }) {
  const ordered = [...chains].reverse();
  return (
    <span className="mh-chain">
      {ordered.map((c, i) => (
        <span key={i}>
          {i ? <span className="mh-chain-arrow">→</span> : null}
          {c}
        </span>
      ))}
    </span>
  );
}
