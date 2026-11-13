// 04 — 412 conflict resolver (two-session: stale → 412, overwrite → 200) + offline replay.
import { uuidv7 } from "./helpers.mjs";

export default async function spec(ctx) {
  const { req, t } = ctx;
  const id = uuidv7();
  const c = await req("POST", "/api/tasks", { id, title: "E2E two-session" }, { "Idempotency-Key": id });
  t("conflict fixture 201", c.status === 201, `got ${c.status}`);
  const gA = await req("GET", `/api/tasks/${id}`);
  const revA = gA.json?.task?.rev ?? gA.json?.rev;
  const adv = await req("PATCH", `/api/tasks/${id}`, { title: "E2E session B wins" }, { "If-Match": `"rev-${revA}"` });
  t("session B advance 200", adv.status === 200, `got ${adv.status}`);
  const stale = await req("PATCH", `/api/tasks/${id}`, { title: "E2E session A stale" }, { "If-Match": `"rev-${revA}"` });
  t("session A stale → 412", stale.status === 412, `got ${stale.status} code=${stale.json?.code}`);
  const cur = await req("GET", `/api/tasks/${id}`);
  const revCur = cur.json?.task?.rev ?? cur.json?.rev;
  const over = await req("PATCH", `/api/tasks/${id}`, { title: "E2E session A overwrite" }, { "If-Match": `"rev-${revCur}"` });
  t("resolver overwrite 200", over.status === 200 && (over.json?.task?.title ?? over.json?.title) === "E2E session A overwrite", `got ${over.status}`);

  // Offline create → replay: same Idempotency-Key twice = queued + replayed, one row.
  const oid = uuidv7();
  const o1 = await req("POST", "/api/tasks", { id: oid, title: "E2E offline queued" }, { "Idempotency-Key": oid });
  const o2 = await req("POST", "/api/tasks", { id: oid, title: "E2E offline queued" }, { "Idempotency-Key": oid });
  t("offline queue 201 + replay 200", o1.status === 201 && o2.status === 200, `got ${o1.status}/${o2.status}`);
  const srch = await req("GET", `/api/search?q=${encodeURIComponent("E2E offline queued")}`);
  const dupes = (srch.json?.tasks ?? srch.json?.items ?? []).filter((x) => (x.title ?? "").includes("E2E offline queued")).length;
  t("replay dedupes (1 row)", dupes === 1, `rows=${dupes}`);
}
