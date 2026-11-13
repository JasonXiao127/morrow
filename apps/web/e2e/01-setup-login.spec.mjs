// 01 — setup (token+password) then login persistence via bootstrap.
import { PASSWORD, uuidv7 } from "./helpers.mjs";

export default async function spec(ctx) {
  const { req, t, state } = ctx;
  const setup = await req("POST", "/api/setup", {
    password: PASSWORD,
    timezone: "UTC",
  });
  t("open setup (no token) → 201", setup.status === 201, `got ${setup.status}`);
  const replay = await req("POST", "/api/setup", {
    password: PASSWORD,
    timezone: "UTC",
  });
  t("setup replay → 409 setup_complete", replay.status === 409, `got ${replay.status}`);
  const boot = await req("GET", "/api/bootstrap");
  t("login persistence: bootstrap 200", boot.status === 200, `got ${boot.status}`);
  t("login persistence: owner user", boot.json?.user?.username === "owner");
  state.key = uuidv7();
}
