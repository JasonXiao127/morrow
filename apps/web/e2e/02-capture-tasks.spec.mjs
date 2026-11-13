// 02 — capture via sheet path (parse + create), then complete / snooze / skip.
import { uuidv7 } from "./helpers.mjs";

export default async function spec(ctx) {
  const { req, t, state } = ctx;
  const text = "E2E refine task tomorrow at 9am";
  const parsed = await req("POST", "/api/capture/parse", { text, timezone: "UTC" });
  t("capture parse 200 + title", parsed.status === 200 && typeof parsed.json?.title === "string", `got ${parsed.status} title=${JSON.stringify(parsed.json?.title)}`);

  const mk = async (title) => {
    const id = uuidv7();
    const r = await req("POST", "/api/tasks", { id, title }, { "Idempotency-Key": id });
    return { id, r };
  };
  const c = await mk("E2E complete me");
  t("create(complete) 201", c.r.status === 201, `got ${c.r.status}`);
  const revC = c.r.json?.task?.rev ?? c.r.json?.rev;
  const done = await req("POST", `/api/tasks/${c.id}/complete`, {}, { "If-Match": `"rev-${revC}"` });
  t("complete → done", done.status === 200 && (done.json?.task?.status ?? done.json?.status) === "done", `got ${done.status}`);

  const s = await mk("E2E snooze me");
  const g2 = await req("GET", `/api/tasks/${s.id}`);
  const revS = g2.json?.task?.rev ?? g2.json?.rev;
  const until = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const snoozed = await req("POST", `/api/tasks/${s.id}/snooze`, { until }, { "If-Match": `"rev-${revS}"` });
  const snz = snoozed.json?.task ?? snoozed.json;
  t("snooze → snoozed_until", snoozed.status === 200 && Boolean(snz?.snoozed_until), `got ${snoozed.status}`);

  const k = await mk("E2E skip me");
  const g3 = await req("GET", `/api/tasks/${k.id}`);
  const revK = g3.json?.task?.rev ?? g3.json?.rev;
  const skipped = await req("POST", `/api/tasks/${k.id}/skip`, {}, { "If-Match": `"rev-${revK}"` });
  t("skip → cancelled", skipped.status === 200 && (skipped.json?.task?.status ?? skipped.json?.status) === "cancelled", `got ${skipped.status}`);
  state.done = true;
}
