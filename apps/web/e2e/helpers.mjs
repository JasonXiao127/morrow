// Shared E2E helpers (node fetch, cookie jar, UUIDv7, TAP-ish reporting).
export const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4591";
export const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "e2e-refine-123";
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-12345";

export function uuidv7(now = Date.now()) {
  const ms = Math.floor(now);
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const timeHex = ms.toString(16).padStart(12, "0");
  const seq = rand.slice(0, 3);
  const variant = ((parseInt(rand[3], 16) & 0x3) | 0x8).toString(16);
  const randB = (variant + rand.slice(4, 16)).padEnd(16, "0").slice(0, 16);
  const hex = `${timeHex}7${seq}${randB}`;
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export function makeCtx() {
  const jar = new Map();
  const lines = [];
  let pass = 0;
  let fail = 0;
  let pending = 0;
  const storeCookie = (res) => {
    const raw = res.headers.get("set-cookie");
    if (!raw) return;
    for (const part of raw.split(/,(?=[^;,]+=)/)) {
      const [kv] = part.split(";");
      const [k, ...rest] = kv.trim().split("=");
      if (k) jar.set(k, rest.join("="));
    }
  };
  const req = async (method, path, body, headers = {}, { form = null } = {}) => {
    const h = { ...headers };
    if ([...jar.keys()].length > 0) {
      h["Cookie"] = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let res;
    if (form) {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: h,
        body: form,
      });
    } else {
      if (body !== undefined) h["Content-Type"] = "application/json";
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    storeCookie(res);
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers, res };
  };
  const t = (name, cond, extra = "") => {
    if (cond) {
      pass += 1;
      lines.push(`PASS ${name}${extra ? ` — ${extra}` : ""}`);
    } else {
      fail += 1;
      lines.push(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
    }
  };
  const p = (name, extra = "") => {
    pending += 1;
    lines.push(`PENDING ${name}${extra ? ` — ${extra}` : ""}`);
  };
  const cookieHeader = async () => {
    const h = {};
    if ([...jar.keys()].length > 0) {
      h["Cookie"] = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    return h;
  };
  return { BASE, req, t, p, lines, state: {}, summary: () => ({ pass, fail, pending }), cookieHeader };
}
