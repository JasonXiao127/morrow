/**
 * CLI password reset (§8: "CLI password reset").
 *
 * Usage:
 *   printf '%s' 'new-strong-password-≥12-chars' |
 *     node dist/reset-password.js -
 *   # or target a named account (default: workspace owner):
 *   printf '%s' 'new-password' |
 *     node dist/reset-password.js --user alice -
 *   # via workspace:
 *   printf '%s' 'new-password' |
 *     pnpm --filter @morrow/server reset-password -
 *
 * Resets ONE account (default owner) and revokes only that account's sessions.
 * Other members keep their passwords and devices signed in. Never prints
 * hashes. Passing the password as an argument still works for compatibility,
 * but it is visible to other local processes through `ps`/`/proc`; prefer
 * stdin (`-`).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDb, initSchema } from "@morrow/db";
import { ensureOwnerRole, hashPassword } from "./auth.js";
import { nowIso } from "@morrow/shared";

const MIN_PASSWORD_LENGTH = 12;

export interface ResetPasswordIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const USAGE =
  "usage: reset-password [--user <username>] <new-password ≥12 chars> | reset-password [--user <username>] -\n";

function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const readable = stream as NodeJS.ReadableStream & {
      setEncoding?: (encoding: BufferEncoding) => void;
    };
    readable.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(data));
  });
}

interface ParsedArgs {
  username: string | null;
  passwordArg: string | null;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let username: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--user" || arg === "--username") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        return { username: null, passwordArg: null, error: "missing username" };
      }
      username = value.trim().toLowerCase();
      i += 1;
    } else if (arg.startsWith("--user=") || arg.startsWith("--username=")) {
      username = arg.slice(arg.indexOf("=") + 1).trim().toLowerCase();
    } else {
      rest.push(arg);
    }
  }
  if (rest.length !== 1) {
    return {
      username,
      passwordArg: null,
      error: rest.length === 0 ? "missing password" : "too many arguments",
    };
  }
  return { username, passwordArg: rest[0] as string };
}

/**
 * Testable entry point. Returns the process exit code instead of exiting so
 * the argv and stdin paths can both be covered without spawning.
 */
export async function runResetPassword(
  argv: string[],
  io: ResetPasswordIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsedArgs = parseArgs(argv);
  if (parsedArgs.error) {
    stderr.write(USAGE);
    return 2;
  }

  let password: string;
  if (parsedArgs.passwordArg === "-") {
    password = (await readStdin(io.stdin ?? process.stdin)).replace(
      /[\r\n]+$/,
      "",
    );
  } else {
    if (parsedArgs.passwordArg === null) {
      stderr.write(USAGE);
      return 2;
    }
    stderr.write(
      "warning: password passed on the command line is visible in ps; pipe it on stdin and pass '-' instead.\n",
    );
    password = parsedArgs.passwordArg;
  }

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    stderr.write(USAGE);
    return 2;
  }
  const db = getDb();
  initSchema(db);
  ensureOwnerRole();

  let target: { id: string; username: string } | undefined;
  if (parsedArgs.username) {
    target = db
      .prepare(
        `SELECT id, username FROM users
          WHERE lower(username) = ? AND deleted_at IS NULL`,
      )
      .get(parsedArgs.username) as { id: string; username: string } | undefined;
  } else {
    target = db
      .prepare(
        `SELECT id, username FROM users
          WHERE role = 'owner' AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as { id: string; username: string } | undefined;
  }
  if (!target) {
    stderr.write(
      parsedArgs.username
        ? `no such account: ${parsedArgs.username}\n`
        : "no owner account found; run POST /api/setup first.\n",
    );
    return 1;
  }

  const hashed = await hashPassword(password);
  const now = nowIso();
  let revoked = 0;
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE users SET password_hash = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
    ).run(hashed, now, target!.id);
    const info = db
      .prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(target!.id);
    revoked = Number(info.changes);
    db.prepare(
      "UPDATE capture_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    ).run(now, target!.id);
  });
  tx();
  stdout.write(
    `password reset for ${target.username}; ${revoked} session(s) revoked.\n`,
  );
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  runResetPassword(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${(err as Error)?.message ?? err}\n`);
      process.exit(1);
    });
}
