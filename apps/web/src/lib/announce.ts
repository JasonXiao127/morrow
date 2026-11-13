/**
 * Screen-reader announcements for actions that change data or sync state.
 * Sonner also announces toasts; this live region keeps the terse result
 * ("Completed Milk", "3 changes waiting") available even if a toast expires.
 */
export const ANNOUNCE_EVENT = "morrow:announce";

export function announce(message: string): void {
  if (typeof window === "undefined" || !message) return;
  window.dispatchEvent(
    new CustomEvent<string>(ANNOUNCE_EVENT, { detail: message }),
  );
}

export function subscribeAnnouncements(
  handler: (message: string) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string") handler(detail);
  };
  window.addEventListener(ANNOUNCE_EVENT, listener);
  return () => window.removeEventListener(ANNOUNCE_EVENT, listener);
}
