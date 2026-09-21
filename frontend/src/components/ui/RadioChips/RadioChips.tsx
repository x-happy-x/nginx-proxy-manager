import type { ReactNode } from "react";
type Props<T extends string> = {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (next: T) => void;
  disabled?: boolean;
};
export function RadioChips<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: Props<T>) {
  return (
    <div role="radiogroup" className="ui-chip-group">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          className={`ui-chip ${value === option.value ? "active" : ""}`}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
