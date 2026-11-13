import { useEffect, useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { cn } from "@/lib/utils";

type DialogKind = "center" | "sheet" | "full";

const kindClass: Record<DialogKind, string> = {
  center: "center-dialog",
  sheet: "sheet-content",
  full: "full-sheet",
};

// Most recently focused element outside any dialog. Updated on focusin so a
// programmatic dialog open can return focus even though autoFocus moves
// document.activeElement inside before mount effects run.
let lastOutsideFocus: HTMLElement | null = null;
let trackingOutsideFocus = false;

function trackOutsideFocus(): void {
  if (trackingOutsideFocus || typeof document === "undefined") return;
  trackingOutsideFocus = true;
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      !target.closest('[role="dialog"]')
    ) {
      lastOutsideFocus = target;
    }
  });
}

trackOutsideFocus();

export function DialogFrame({
  open,
  onOpenChange,
  title,
  description,
  kind = "center",
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  kind?: DialogKind;
  children: ReactNode;
  className?: string;
}) {
  // Radix returns focus to a Dialog.Trigger; these dialogs open
  // programmatically (N/C, Cmd+K, conflict reports), so the trigger ref is
  // empty and focus is dropped to <body> on close. Return to the opener when
  // the dialog closes and nothing else took focus.
  //
  // The snapshot cannot be document.activeElement on open: dialog autoFocus
  // moves focus inside before mount effects run. Track the last element
  // focused outside any dialog instead.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && !active.closest('[role="dialog"]')
          ? active
          : lastOutsideFocus;
      return;
    }
    const target = openerRef.current;
    openerRef.current = null;
    if (!target || !target.isConnected) return;
    // Radix Presence unmounts the portal after this effect runs, so focus
    // may still be inside the closing dialog here. Decide after two frames,
    // once removal (and the browser's drop to <body>) has happened — but
    // never steal focus the user already moved elsewhere.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!target.isConnected) return;
        const active = document.activeElement;
        if (active !== document.body && active !== null) return;
        target.focus({ preventScroll: true });
      });
    });
  }, [open ]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={cn("dialog-content", kindClass[kind], className)}
        >
          <VisuallyHidden>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description>{description ?? title}</Dialog.Description>
          </VisuallyHidden>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
