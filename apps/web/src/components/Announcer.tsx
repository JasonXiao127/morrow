import { useEffect, useRef, useState } from "react";
import { subscribeAnnouncements } from "@/lib/announce";

/** Visually hidden polite live region for action/sync results. */
export function Announcer() {
  const [message, setMessage] = useState("");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeAnnouncements((next) => {
      setMessage(next);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMessage(""), 6_000);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="announcer"
    >
      {message}
    </div>
  );
}
