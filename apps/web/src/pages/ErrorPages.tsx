import { useEffect } from "react";
import { FatalError } from "@/components/FatalError";

export function ErrorPage({ error }: { error?: unknown }) {
  useEffect(() => {
    if (error) console.error("[morrow] route error", error);
  }, [error]);

  return (
    <FatalError
      title="This page slipped away."
      description="Morrow hit an unexpected problem. Your tasks are safe on the server. Reload to try again."
    />
  );
}

export function NotFoundPage() {
  return (
    <FatalError
      title="That page doesn’t exist."
      description="The link may be old, or the page may have moved. Today is a reliable place to start."
      showRetry={false}
    />
  );
}
