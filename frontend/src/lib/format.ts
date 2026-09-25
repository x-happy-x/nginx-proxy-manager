const numberFormat = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 1,
});

export function number(value: number | undefined | null): string {
  return value == null || Number.isNaN(value) ? "—" : numberFormat.format(value);
}

export function compact(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) < 10000) return numberFormat.format(Math.round(value));
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function bytes(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  let current = value;
  while (current >= 1024 && i < units.length - 1) {
    current /= 1024;
    i++;
  }
  return `${number(current)} ${units[i]}`;
}

export function ms(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  if (value >= 1000) return `${number(value / 1000)} с`;
  return `${number(value < 10 ? value : Math.round(value))} мс`;
}

/** Russian plural form: plural(5, ["сервис", "сервиса", "сервисов"]). */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function count(n: number, forms: [string, string, string]): string {
  return `${number(n)} ${plural(n, forms)}`;
}

function toDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function timeOf(value: unknown): string {
  const date = toDate(value);
  if (!date) return String(value || "—");
  return date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dateTime(value: unknown): string {
  const date = toDate(value);
  if (!date) return String(value || "—");
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shortDate(value: unknown): string {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

/** `nginx -v` output ("nginx version: WebServer/1.0") reduced to the version itself. */
export function nginxVersion(value: string | undefined): string {
  return (value || "").replace(/^\s*nginx version:\s*/i, "").trim();
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || "Неизвестная ошибка");
}

export function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "??";
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}
