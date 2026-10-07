/*
 * Country flags in node names (NPM-59). Windows draws flag emoji as two
 * letters, so the UI takes the flag out of the name and shows a picture.
 */

const RI_A = 0x1f1e6;

/** Two regional indicators anywhere in the text → "NL"; "" if none. */
export function flagCode(text: string): string {
  const cps = [...text].map((c) => c.codePointAt(0) || 0);
  for (let i = 0; i + 1 < cps.length; i++) {
    if (isRI(cps[i]) && isRI(cps[i + 1])) return String.fromCharCode(cps[i] - RI_A + 65, cps[i + 1] - RI_A + 65);
  }
  return "";
}

/** The name without flag emoji and without the spaces they leave. */
export function stripFlags(text: string): string {
  return [...text]
    .filter((c) => !isRI(c.codePointAt(0) || 0))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "NL" → 🇳🇱, for text that must stay text (selects, titles). */
export function flagEmoji(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => RI_A + c.charCodeAt(0) - 65));
}

function isRI(cp: number) {
  return cp >= RI_A && cp <= RI_A + 25;
}

export const COUNTRY_RU: Record<string, string> = {
  RU: "Россия", LT: "Литва", LV: "Латвия", EE: "Эстония", DE: "Германия", NL: "Нидерланды", FI: "Финляндия", PL: "Польша", SE: "Швеция", FR: "Франция",
  GB: "Великобритания", US: "США", CA: "Канада", TR: "Турция", KZ: "Казахстан", AM: "Армения", GE: "Грузия", AE: "ОАЭ", JP: "Япония", SG: "Сингапур",
  HK: "Гонконг", AT: "Австрия", CH: "Швейцария", CZ: "Чехия", MD: "Молдова", UA: "Украина", BY: "Беларусь", IT: "Италия", ES: "Испания", RO: "Румыния",
  BG: "Болгария", HU: "Венгрия", IL: "Израиль", IN: "Индия", NO: "Норвегия", DK: "Дания", BE: "Бельгия", IE: "Ирландия", PT: "Португалия", GR: "Греция",
  HR: "Хорватия", SK: "Словакия", SI: "Словения", RS: "Сербия", KR: "Южная Корея", AU: "Австралия", BR: "Бразилия", AR: "Аргентина", MX: "Мексика",
  CO: "Колумбия", PE: "Перу", ZA: "ЮАР", NG: "Нигерия", MY: "Малайзия", UZ: "Узбекистан", KG: "Киргизия", AZ: "Азербайджан", CY: "Кипр", IS: "Исландия",
  LU: "Люксембург", EU: "Евросоюз", FM: "Микронезия", CN: "Китай", TW: "Тайвань", VN: "Вьетнам", TH: "Таиланд", ID: "Индонезия", PH: "Филиппины",
};

export const countryName = (cc: string) => COUNTRY_RU[cc.toUpperCase()] || cc.toUpperCase();

export type FlagMode = "exit" | "name";
export const FLAG_MODE_KEY = "homenet.flags.mode";

/** Which flag to draw: the checked exit country, or the one in the name (each falls back to the other). */
export function nodeCC(name: string, exit: string | undefined, mode: FlagMode): string {
  const own = flagCode(name);
  const ex = (exit || "").toUpperCase();
  return mode === "exit" ? ex || own : own || ex;
}

export function readFlagMode(): FlagMode {
  try {
    return localStorage.getItem(FLAG_MODE_KEY) === "name" ? "name" : "exit";
  } catch {
    return "exit";
  }
}
