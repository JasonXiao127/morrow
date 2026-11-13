// E2E orchestrator: runs each spec in order, prints terse per-check lines.
import { makeCtx } from "./helpers.mjs";
import s01 from "./01-setup-login.spec.mjs";
import s02 from "./02-capture-tasks.spec.mjs";
import s03 from "./03-lists-search.spec.mjs";
import s04 from "./04-conflict-offline.spec.mjs";
import s05 from "./05-backup-push-session.spec.mjs";
import s06 from "./06-mobile-m4.spec.mjs";

const ctx = makeCtx();
for (const [name, spec] of [
  ["01-setup-login", s01],
  ["02-capture-tasks", s02],
  ["03-lists-search", s03],
  ["04-conflict-offline", s04],
  ["05-backup-push-session", s05],
  ["06-mobile-m4", s06],
]) {
  try {
    await spec(ctx);
  } catch (err) {
    ctx.t(`${name} threw`, false, String(err?.message ?? err).slice(0, 200));
  }
}
for (const line of ctx.lines) console.log(line);
const { pass, fail, pending } = ctx.summary();
console.log(`SUMMARY pass=${pass} fail=${fail} pending=${pending}`);
process.exit(fail > 0 ? 1 : 0);
