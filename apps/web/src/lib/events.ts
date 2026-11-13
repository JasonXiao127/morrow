import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Activity SSE client (plan §5 / §7).
 *
 * The server sends the §5 envelope on the default `message` event:
 *   {v:1,id,type,at,entity:{kind,id,rev},data}
 * A named `hello` event carries the bootstrap cursor. Native EventSource
 * reconnects and replays `Last-Event-ID` automatically; this hook adds a
 * manual reconnect with exponential backoff for the CLOSED case and
 * reconnects immediately when the browser comes back online.
 *
 * It intentionally does not import the query client: consumers can listen for
 * `morrow:activity` (or use `onEvent`) and invalidate the queries they own.
 */

export interface ActivityEnvelope<T = unknown> {
  v: 1;
  id: string;
  type: string;
  at: string;
  entity: { kind: string; id: string; rev: number };
  data: T;
}

export interface ActivityHello {
  v: 1;
  at: string;
  cursor: number;
  heartbeatMs?: number;
}

export interface ActivityStreamOptions {
  url?: string;
  onEvent?: (event: ActivityEnvelope) => void;
  onHello?: (hello: ActivityHello) => void;
  onError?: (error: Event | Error) => void;
}

export interface ActivityStreamState {
  connected: boolean;
  lastEventId: string | null;
  cursor: number;
  error: string | null;
}

const ACTIVITY_EVENT = "morrow:activity";
const DEFAULT_URL = "/api/events";
const MAX_BACKOFF_MS = 30_000;

function buildUrl(base: string, lastEventId: string | null): string {
  if (!lastEventId) return base;
  try {
    const url = new URL(base, window.location.origin);
    url.searchParams.set("lastEventId", lastEventId);
    return `${url.pathname}${url.search}`;
  } catch {
    return base;
  }
}

function parseEnvelope(raw: string): ActivityEnvelope | null {
  try {
    const value = JSON.parse(raw) as Partial<ActivityEnvelope>;
    if (!value || value.v !== 1 || typeof value.id !== "string") return null;
    if (typeof value.type !== "string" || typeof value.at !== "string") {
      return null;
    }
    if (
      !value.entity ||
      typeof value.entity.kind !== "string" ||
      typeof value.entity.id !== "string"
    ) {
      return null;
    }
    return {
      v: 1,
      id: value.id,
      type: value.type,
      at: value.at,
      entity: {
        kind: value.entity.kind,
        id: value.entity.id,
        rev:
          typeof value.entity.rev === "number" ? value.entity.rev : 0,
      },
      data: value.data,
    };
  } catch {
    return null;
  }
}

export interface ActivityStreamHandle {
  close: () => void;
  reconnect: () => void;
}

export function connectActivityStream(
  options: ActivityStreamOptions = {},
): ActivityStreamHandle {
  if (typeof window === "undefined" || !("EventSource" in window)) {
    return { close: () => undefined, reconnect: () => undefined };
  }

  let source: EventSource | null = null;
  let closed = false;
  let lastEventId: string | null = null;
  let backoffMs = 1_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let authFailed = false;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (closed || timer) return;
    const delay = Math.min(MAX_BACKOFF_MS, backoffMs) + Math.random() * 250;
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (closed) return;
    clearTimer();
    try {
      source?.close();
    } catch {
      // ignore
    }
    const es = new EventSource(buildUrl(options.url ?? DEFAULT_URL, lastEventId), {
      withCredentials: true,
    });
    source = es;

    es.addEventListener("hello", (event) => {
      backoffMs = 1_000;
      authFailed = false;
      try {
        const hello = JSON.parse((event as MessageEvent).data) as ActivityHello;
        if (typeof hello.cursor === "number" && !lastEventId) {
          lastEventId = String(hello.cursor);
        }
        options.onHello?.(hello);
      } catch {
        // A malformed hello is non-fatal; activity messages still work.
      }
    });

    es.onmessage = (event: MessageEvent<string>) => {
      backoffMs = 1_000;
      authFailed = false;
      if (event.lastEventId) lastEventId = event.lastEventId;
      const envelope = parseEnvelope(event.data);
      if (!envelope) return;
      if (!event.lastEventId) lastEventId = envelope.id;
      options.onEvent?.(envelope);
      window.dispatchEvent(
        new CustomEvent<ActivityEnvelope>(ACTIVITY_EVENT, {
          detail: envelope,
        }),
      );
    };

    // Some proxies may name activity events explicitly.
    es.addEventListener("activity", (event) => {
      const message = event as MessageEvent<string>;
      if (message.lastEventId) lastEventId = message.lastEventId;
      const envelope = parseEnvelope(message.data);
      if (!envelope) return;
      options.onEvent?.(envelope);
      window.dispatchEvent(
        new CustomEvent<ActivityEnvelope>(ACTIVITY_EVENT, {
          detail: envelope,
        }),
      );
    });

    es.onerror = (event) => {
      // 401/403 cannot be distinguished from a network failure here. The app
      // session layer handles expiry; retrying a few times is harmless.
      options.onError?.(event);
      if (es.readyState === EventSource.CLOSED) {
        if (!authFailed) {
          authFailed = true;
          // Try one immediate reconnect once; then fall back to backoff.
          schedule();
        } else {
          schedule();
        }
      }
    };

    es.onopen = () => {
      backoffMs = 1_000;
    };
  };

  const onOnline = (): void => {
    backoffMs = 1_000;
    if (!source || source.readyState === EventSource.CLOSED) open();
  };
  window.addEventListener("online", onOnline);

  open();

  return {
    close: () => {
      closed = true;
      clearTimer();
      window.removeEventListener("online", onOnline);
      try {
        source?.close();
      } catch {
        // ignore
      }
      source = null;
    },
    reconnect: () => {
      backoffMs = 1_000;
      open();
    },
  };
}

export function useActivityStream(options: ActivityStreamOptions = {}): ActivityStreamState & {
  reconnect: () => void;
} {
  const [state, setState] = useState<ActivityStreamState>({
    connected: false,
    lastEventId: null,
    cursor: 0,
    error: null,
  });
  const handleRef = useRef<ActivityStreamHandle | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let disposed = false;
    const handle = connectActivityStream({
      url: optionsRef.current.url,
      onEvent: (event) => {
        optionsRef.current.onEvent?.(event);
        setState((previous) => ({
          ...previous,
          connected: true,
          lastEventId: event.id,
          error: null,
        }));
      },
      onHello: (hello) => {
        optionsRef.current.onHello?.(hello);
        setState((previous) => ({
          ...previous,
          connected: true,
          cursor: hello.cursor,
          lastEventId: previous.lastEventId ?? String(hello.cursor),
          error: null,
        }));
      },
      onError: (error) => {
        optionsRef.current.onError?.(error);
        if (disposed) return;
        setState((previous) => ({
          ...previous,
          connected: false,
          error: "Activity stream disconnected; reconnecting…",
        }));
      },
    });
    handleRef.current = handle;
    return () => {
      disposed = true;
      handle.close();
      if (handleRef.current === handle) handleRef.current = null;
    };
    // The connection is intentionally tied to the URL only; callbacks live in
    // a ref so an inline function does not tear down the stream every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.url]);

  const reconnect = useCallback(() => {
    setState((previous) => ({ ...previous, error: null }));
    handleRef.current?.reconnect();
  }, []);

  return { ...state, reconnect };
}

/** Listen for envelopes without owning a connection. */
export function onActivity(
  handler: (event: ActivityEnvelope) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ActivityEnvelope>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(ACTIVITY_EVENT, listener);
  return () => window.removeEventListener(ACTIVITY_EVENT, listener);
}

export { ACTIVITY_EVENT };
