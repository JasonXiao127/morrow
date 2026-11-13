/**
 * Request logging without credential-bearing query strings.
 *
 * Calendar subscription feeds (`/api/calendar.ics?token=…`) and the email
 * webhook (`/api/inbound/email?token=…`) must keep query tokens for dumb
 * clients that cannot send Authorization headers. Fastify/pino would otherwise
 * log `req.url` verbatim, putting a long-lived credential in the access log.
 *
 * The request serializer below keeps the path and non-sensitive query
 * parameters but replaces sensitive values with `[REDACTED]`. Caddy applies the
 * same rule at the edge (see `Caddyfile`); `apps/server/test/logging.test.ts`
 * checks both configurations.
 */
import type { FastifyRequest } from "fastify";

const SENSITIVE_QUERY_KEY =
  /(^|[-_.])(token|secret|password|passwd|key|signature|auth|credential|session)([-_.]|$)/i;

export const REDACTED = "[REDACTED]";

export function redactSensitiveQuery(url: string): string {
  const hashIndex = url.indexOf("#");
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutFragment = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex < 0) return withoutFragment + fragment;

  const path = withoutFragment.slice(0, queryIndex);
  const query = withoutFragment.slice(queryIndex + 1);
  if (!query) return path + "?" + fragment;

  const params = new URLSearchParams(query);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  if (!changed) return withoutFragment + fragment;
  return `${path}?${params.toString().replaceAll("%5BREDACTED%5D", REDACTED)}${fragment}`;
}

interface RequestLike {
  id?: string | number;
  method?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}

/** Pino `serializers.req`: safe metadata only, never headers or raw query. */
export function requestLogSerializer(req: RequestLike): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: redactSensitiveQuery(req.url ?? ""),
    remoteAddress: req.ip,
    host: typeof req.headers?.["host"] === "string" ? req.headers["host"] : undefined,
  };
}

/** Paths pino should redact even if a structured field carries them. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-readyz-token']",
  "req.headers['x-morrow-token']",
  "req.headers['x-api-key']",
  "req.query.token",
  "req.query.access_token",
  "req.query.key",
  "req.query.api_key",
  "req.query.signature",
  "req.query.password",
  "req.body.password",
  "req.body.token",
  "res.headers['set-cookie']",
  "*.password",
  "*.password_hash",
  "*.token",
  "*.token_hash",
  "*setupToken*",
  "*sessionToken*",
] as const;

export interface LoggerOptionsInput {
  level: string;
}

/** Fastify logger options shared by the real app and the logging tests. */
export function buildLoggerOptions(input: LoggerOptionsInput): Record<string, unknown> {
  return {
    level: input.level,
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    serializers: { req: requestLogSerializer },
  };
}

/** Convenience for Fastify's `logger` option; keeps types explicit. */
export function fastifyLoggerOptions(level: string) {
  return buildLoggerOptions({ level });
}

export type LoggedRequest = FastifyRequest;
