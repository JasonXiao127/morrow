/**
 * application/problem+json helpers (§5 Errors).
 * Content-Type: application/problem+json with type/title/status/detail/code/traceId.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { problem } from "@morrow/shared";

export interface ProblemOptions {
  type?: string;
  detail?: string;
  code?: string;
}

export function sendProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  opts: ProblemOptions = {},
): FastifyReply {
  const traceId = (req.id ?? "") as string;
  const body = problem(status, title, {
    ...opts,
    ...(traceId ? { traceId } : {}),
  });
  return reply
    .code(status)
    .header("content-type", "application/problem+json")
    .header("cache-control", "no-store")
    .send(body);
}

export const badRequest = (
  req: FastifyRequest,
  reply: FastifyReply,
  detail: string,
  code = "bad_request",
) => sendProblem(req, reply, 400, "Bad Request", { detail, code });

export const unauthorized = (
  req: FastifyRequest,
  reply: FastifyReply,
  code = "unauthorized",
  detail = "Authentication required.",
) => sendProblem(req, reply, 401, "Unauthorized", { detail, code });

export const forbidden = (
  req: FastifyRequest,
  reply: FastifyReply,
  code = "forbidden",
  detail = "Forbidden.",
) => sendProblem(req, reply, 403, "Forbidden", { detail, code });

export const notFound = (
  req: FastifyRequest,
  reply: FastifyReply,
  code = "not_found",
  detail = "Not found.",
) => sendProblem(req, reply, 404, "Not Found", { detail, code });

export const conflict = (
  req: FastifyRequest,
  reply: FastifyReply,
  code = "conflict",
  detail = "Conflict.",
) => sendProblem(req, reply, 409, "Conflict", { detail, code });

/** 428 Precondition Required — If-Match missing on a guarded mutation. */
export function preconditionRequired(
  req: FastifyRequest,
  reply: FastifyReply,
  detail = "If-Match header is required.",
) {
  return sendProblem(req, reply, 428, "Precondition Required", {
    detail,
    code: "precondition_required",
  });
}

/** 412 Precondition Failed — stale rev; include current representation hint. */
export function preconditionFailed(
  req: FastifyRequest,
  reply: FastifyReply,
  currentRev: number,
  detail?: string,
) {
  return sendProblem(req, reply, 412, "Precondition Failed", {
    detail: detail ?? `Stale revision. Current rev is ${currentRev}.`,
    code: "stale_revision",
  });
}
