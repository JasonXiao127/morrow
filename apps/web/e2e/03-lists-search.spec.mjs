// 03 — list create/rename + search (Cmd+K path hits GET /api/search).
import { uuidv7 } from "./helpers.mjs";

export default async function spec(ctx) {
  const { req, t, state } = ctx;
  const lid = uuidv7();
  const created = await req("POST", "/api/lists", { id: lid, name: "E2E List" }, { "Idempotency-Key": lid });
  t("list create 201", created.status === 201, `got ${created.status}`);
  const lrev = created.json?.list?.rev ?? created.json?.rev;
  const renamed = await req("PATCH", `/api/lists/${lid}`, { name: "E2E List Renamed" }, { "If-Match": `"rev-${lrev}"` });
  t("list rename 200", renamed.status === 200 && (renamed.json?.list?.name ?? renamed.json?.name) === "E2E List Renamed", `got ${renamed.status}`);
  const search = await req("GET", `/api/search?q=${encodeURIComponent("E2E complete me")}`);
  const hits = search.json?.tasks ?? search.json?.items ?? [];
  t("search finds task (Cmd+K backend)", search.status === 200 && hits.some((x) => (x.title ?? "").includes("E2E complete me")), `got ${search.status}, hits=${hits.length}`);
  state.listId = lid;
}
