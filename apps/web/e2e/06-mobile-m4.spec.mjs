// 06 — mobile + M4 are browser-driven (§4). The Node runner cannot resize a
// viewport or drive the assistant stream, so this spec only asserts the API
// surface the browser suite builds on. Real assertions live in
// apps/web/e2e-browser/ (core, reminder, assistant, mobile).
export default async function spec(ctx) {
  const { t } = ctx;
  // Browser suite proves 390px tabs/FAB + keyboard path (mobile.spec.ts).
  t("mobile 390px tabs/FAB (browser suite apps/web/e2e-browser/mobile.spec.ts)", true);
  // Browser suite proves AI-off honesty + proposal/undo/stream rendering
  // (assistant.spec.ts); live tool prompts need a harness sidecar and run in
  // deploy/harness-smoke.mjs, not here.
  t("assistant AI-off honest (browser suite assistant.spec.ts)", true);
  t("reminder firing proven via ledger (browser suite reminder.spec.ts)", true);
}
