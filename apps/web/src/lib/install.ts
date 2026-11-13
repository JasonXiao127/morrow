import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/.test(navigator.userAgent);
}

export type InstallPlatform = "ios" | "android" | "desktop";

/** Called once from main.tsx so the install prompt is captured app-wide. */
export function initInstallPrompt(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });

  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", notify);
}

export function useInstallPrompt(): {
  available: boolean;
  installed: boolean;
  ios: boolean;
  android: boolean;
  platform: InstallPlatform;
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
} {
  const [available, setAvailable] = useState(Boolean(deferredPrompt));
  const [installed, setInstalled] = useState(isStandalone);
  const ios = isIos();
  const android = !ios && isAndroid();

  useEffect(() => {
    initInstallPrompt();
    const update = () => {
      setAvailable(Boolean(deferredPrompt));
      setInstalled(isStandalone());
    };
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return "unavailable" as const;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      deferredPrompt = null;
      notify();
    }
    return choice.outcome;
  }, []);

  return {
    available,
    installed,
    ios,
    android,
    platform: ios ? "ios" : android ? "android" : "desktop",
    promptInstall,
  };
}
