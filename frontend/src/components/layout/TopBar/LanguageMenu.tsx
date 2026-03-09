import { Select } from "@x-happy-x/ui-kit";
import type { Locale } from "../../../i18n";
import "./LanguageMenu.scss";

type Props = {
  locale: Locale;
  onChange: (next: Locale) => void;
  title: string;
  ruLabel: string;
  enLabel: string;
};

export function LanguageMenu({ locale, onChange, title, ruLabel, enLabel }: Props) {
  return (
    <div className="lang-switch" aria-label={title}>
      <Select
        className="lang-switch__select"
        value={locale}
        onChange={onChange}
        options={[
          { value: "ru", label: ruLabel },
          { value: "en", label: enLabel },
        ]}
      />
    </div>
  );
}
