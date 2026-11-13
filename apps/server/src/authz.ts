/**
 * Route authorization helpers (v0.2 Round 2).
 *
 * Authentication always comes first. Global/admin surfaces are then gated to
 * the workspace owner; members receive a problem+json 403 with code
 * `owner_only`. UI hiding is advisory only — every gated route checks here.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateRequest,
  isOwner,
  type SessionRow,
  type UserRow,
} from "./auth.js";
import { forbidden, unauthorized } from "./errors.js";

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): AuthContext | null {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  return auth;
}

export function requireOwner(
  req: FastifyRequest,
  reply: FastifyReply,
): AuthContext | null {
  const auth = requireAuth(req, reply);
  if (!auth) return null;
  if (!isOwner(auth.user)) {
    forbidden(
      req,
      reply,
      "owner_only",
      "Only the workspace owner can manage this feature.",
    );
    return null;
  }
  return auth;
}
