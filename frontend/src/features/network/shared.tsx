import type { ReactNode } from "react";
import type { Analysis, StepStatus } from "../../api";
import { Icon, type IconName } from "../../components/ui/Icon";

export type Tone = "good" | "warning" | "critical" | "neutral" | "info";

// Every state is shown as icon + words, never colour alone.
export function Tag({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  const icon: IconName = tone === "good" ? "checkCircle" : tone === "warning" ? "alert" : tone === "critical" ? "error" : tone === "info" ? "info" : "minus";
  return (
    <span className={`net-tag net-tag-${tone}`} title={title}>
      <Icon name={icon} size={12} />
      {children}
    </span>
  );
}

export const ANALYSIS_VERDICT: Record<Analysis["verdict"], { tone: Tone; label: string }> = {
  open: { tone: "good", label: "Открыт" },
  bypassed: { tone: "info", label: "Блок обходится" },
  partial: { tone: "warning", label: "Клиенты упираются в блок" },
  "proxy-broken": { tone: "warning", label: "Сломан через прокси" },
  down: { tone: "critical", label: "Недоступен" },
  blocked: { tone: "critical", label: "Не работает" },
};

export const PATH_VERDICT: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "good", label: "работает" },
  dns: { tone: "critical", label: "DNS" },
  ip: { tone: "critical", label: "IP" },
  sni: { tone: "critical", label: "SNI" },
  freeze: { tone: "critical", label: "IP заглушён" },
  tls: { tone: "critical", label: "TLS" },
  stub: { tone: "critical", label: "заглушка" },
  throttle: { tone: "critical", label: "16–20 КБ" },
  http: { tone: "warning", label: "HTTP" },
  error: { tone: "warning", label: "ошибка" },
  skip: { tone: "neutral", label: "нет данных" },
};

export function pathVerdict(v: string) {
  return PATH_VERDICT[v] || { tone: "neutral" as Tone, label: v || "—" };
}

export const PATH_TITLES: Record<string, string> = {
  direct: "Netcraze напрямую",
  mihomo: "Через mihomo",
  mikrotik: "MikroTik",
};

export function stepTone(status: StepStatus): Tone {
  return status === "ok" ? "good" : status === "fail" ? "critical" : status === "warn" ? "warning" : "neutral";
}

export function StepIcon({ status }: { status: StepStatus }) {
  const icon: IconName = status === "ok" ? "check" : status === "fail" ? "error" : status === "warn" ? "alert" : "minus";
  return (
    <span className={`net-step-icon net-${stepTone(status)}`}>
      <Icon name={icon} size={13} strokeWidth={2.2} />
    </span>
  );
}

export const STAGES: Array<{ id: string; label: string; hint: string }> = [
  { id: "dns", label: "DNS", hint: "Получение адреса" },
  { id: "tcp", label: "TCP", hint: "Соединение с сервером" },
  { id: "tls", label: "TLS", hint: "Рукопожатие с именем сайта (SNI)" },
  { id: "http", label: "HTTP", hint: "Ответ сайта, заглушки" },
  { id: "bulk", label: "16–20 КБ", hint: "Не обрывается ли поток после 16–20 КБ" },
];

export function formatMs(ms?: number | null) {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} с`;
  return `${ms >= 10 ? Math.round(ms) : ms.toFixed(1)} мс`;
}

export function formatAgo(unix: number) {
  if (!unix) return "—";
  const sec = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (sec < 60) return `${sec} с назад`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин назад`;
  return new Date(unix * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatClock(unix: number) {
  return new Date(unix * 1000).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(sec: number) {
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин ${sec % 60} с`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}
