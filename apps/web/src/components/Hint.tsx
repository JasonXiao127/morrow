import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

/** Accessible hover/focus hint for icon-only controls. */
export function Hint({
  label,
  children,
  side = "bottom",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip.Root delayDuration={350}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          className="z-[70] rounded-md border border-hairline bg-ink px-2 py-1 text-12 font-medium text-canvas shadow-sm"
        >
          {label}
          <Tooltip.Arrow className="fill-ink" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
