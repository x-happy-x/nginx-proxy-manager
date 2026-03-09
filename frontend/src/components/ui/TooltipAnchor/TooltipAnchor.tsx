import type { ReactElement } from "react";
import { Tooltip } from "@x-happy-x/ui-kit";

type Props = {
  tooltip: string;
  children: ReactElement;
};

export function TooltipAnchor({ tooltip, children }: Props) {
  return <Tooltip content={tooltip}>{children as ReactElement}</Tooltip>;
}
