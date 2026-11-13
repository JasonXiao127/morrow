import { useCallback, useEffect, useState } from "react";
import {
  getOutboxConflicts,
  getOutboxCount,
  lastSyncedAt as readLastSyncedAt,
  listOutbox,
  outboxIsReplaying,
} from "./outbox";
import type { OutboxRecord } from "./idb";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useOutboxCount(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    void getOutboxCount().then(setCount);
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("morrow:outbox", onChange);
    window.addEventListener("online", onChange);
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener("morrow:outbox", onChange);
      window.removeEventListener("online", onChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return count;
}

export interface OutboxState {
  count: number;
  conflicts: number;
  records: OutboxRecord[];
  syncing: boolean;
  lastSyncedAt: string | null;
  refresh: () => void;
}

/** Full outbox state for the banner, panel, and syncing indicators. */
export function useOutboxState(): OutboxState {
  const [state, setState] = useState<Omit<OutboxState, "refresh">>({
    count: 0,
    conflicts: 0,
    records: [],
    syncing: false,
    lastSyncedAt: null,
  });

  const refresh = useCallback(() => {
    void (async () => {
      const [records, count, conflicts] = await Promise.all([
        listOutbox(),
        getOutboxCount(),
        getOutboxConflicts(),
      ]);
      setState({
        records,
        count,
        conflicts,
        syncing: outboxIsReplaying(),
        lastSyncedAt: readLastSyncedAt(),
      });
    })();
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("morrow:outbox", onChange);
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener("morrow:outbox", onChange);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { ...state, refresh };
}
