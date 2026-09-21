import type { ReactElement } from "react";

type Props = {
  tooltip: string;
  children: ReactElement;
};

export function TooltipAnchor({ tooltip, children }: Props) {
  return (
    <span className="tooltip-anchor" title={tooltip}>
      {children}
    </span>
  );
}
