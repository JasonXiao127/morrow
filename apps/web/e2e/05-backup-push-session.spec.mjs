// 05 — backup export/import dryRun (M3), push-denied copy, session-expiry redirect.
import { PASSWORD } from "./helpers.mjs";

export default async function spec(ctx) {
  const { req, t, BASE } = ctx;
  const step = await req("POST", "/api/auth/password", { password: PASSWORD });
  t("step-up 200 (export/import gate)", step.status === 200, `got ${step.status}`);
  const exp = await req("GET", "/api/backup/export");
  t("backup export 200 json", exp.status === 200, `got ${exp.status}`);
  // Re-export bytes through the authed jar for the multipart import.
  const expRes = await fetch(`${BASE}/api/backup/export`, {
    headers: await ctx.cookieHeader(),
  });
  const buf = Buffer.from(await expRes.arrayBuffer());
  const fd = new FormData();
  fd.append("backup", new Blob([buf], { type: "application/json" }), "backup.json");
  const dry = await req("POST", "/api/backup/import?dryRun=1", undefined, {}, { form: fd });
  t("backup import dryRun 200 + counts", dry.status === 200 && Boolean(dry.json?.counts), `got ${dry.status} counts=${JSON.stringify(dry.json?.counts)}`);

  const push = await req("GET", "/api/push/vapid-public-key");
  t("push denied 503 push_not_configured", push.status === 503 && push.json?.code === "push_not_configured", `got ${push.status}`);

  const logout = await req("POST", "/api/logout", {});
  t("logout 200", logout.status === 200, `got ${logout.status}`);
  const boot = await req("GET", "/api/bootstrap");
  t("session-expiry: bootstrap 401 after logout", boot.status === 401, `got ${boot.status}`);
  const expiredPage = await fetch(`${BASE}/session-expired`);
  t("session-expired page serves", expiredPage.status === 200, `got ${expiredPage.status}`);
}
