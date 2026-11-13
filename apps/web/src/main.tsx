import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-500.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "sonner/dist/styles.css";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { persistOptions } from "@/lib/query-persistence";
import { queryClient } from "@/lib/query";
import { initInstallPrompt } from "@/lib/install";
import { registerServiceWorker } from "@/lib/pwa";
import { requestPersistentStorage } from "@/lib/storage";
import { router } from "@/router";

initInstallPrompt();
registerServiceWorker();
void requestPersistentStorage();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Morrow root element is missing");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistOptions}
        onError={() => console.warn("[morrow] query cache restore failed")}
      >
        <RouterProvider router={router} />
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
