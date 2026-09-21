import type { Locale } from "../../../i18n";
export function LanguageMenu({
  locale,
  onChange,
  title,
  ruLabel,
  enLabel,
}: {
  locale: Locale;
  onChange: (next: Locale) => void;
  title: string;
  ruLabel: string;
  enLabel: string;
}) {
  return (
    <select
      aria-label={title}
      value={locale}
      onChange={(event) => onChange(event.target.value as Locale)}
    >
      <option value="ru">{ruLabel}</option>
      <option value="en">{enLabel}</option>
    </select>
  );
}
