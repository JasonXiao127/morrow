/**
 * Deployment URL validation: APP_URL must describe the same origin as the
 * Caddy `SITE_ADDRESS`. A mismatch is not fatal (same-origin requests still
 * work) but boots with a warning instead of failing later as a "wrong
 * password" or "wrong setup token".
 */
import { describe, expect, it } from "vitest";
import {
  deploymentUrlWarnings,
  isPublicOrigin,
} from "../src/config.js";

describe("deploymentUrlWarnings", () => {
  it("accepts a coherent plain-HTTP pair", () => {
    expect(deploymentUrlWarnings(":80", "http://localhost")).toEqual([]);
    expect(
      deploymentUrlWarnings(":80", "http://192.168.1.10:3100"),
    ).toEqual([]);
  });

  it("accepts a coherent HTTPS hostname pair", () => {
    expect(deploymentUrlWarnings("morrow.example.com", "https://morrow.example.com")).toEqual(
      [],
    );
    expect(deploymentUrlWarnings("localhost", "https://localhost")).toEqual([]);
    expect(deploymentUrlWarnings(":443", "https://localhost")).toEqual([]);
  });

  it("flags the scaffold's known scheme mismatch", () => {
    const warnings = deploymentUrlWarnings("localhost", "http://localhost");
    expect(warnings.join(" ")).toContain("serves https");
  });

  it("flags a host mismatch", () => {
    const warnings = deploymentUrlWarnings(
      "morrow.example.com",
      "https://other.example.com",
    );
    expect(warnings.join(" ")).toContain("does not match SITE_ADDRESS");
  });

  it("flags an APP_URL that is not a bare origin", () => {
    const warnings = deploymentUrlWarnings(undefined, "http://localhost/app");
    expect(warnings.join(" ")).toContain("bare origin");
    expect(deploymentUrlWarnings(undefined, "not a url").join(" ")).toContain(
      "not a valid absolute URL",
    );
  });

  it("does not guess when SITE_ADDRESS is unset", () => {
    expect(deploymentUrlWarnings(undefined, "http://localhost:3100")).toEqual(
      [],
    );
  });

  it("accepts a Tailscale or external-proxy deployment with no Caddy site", () => {
    expect(
      deploymentUrlWarnings(
        undefined,
        "https://morrow.example.ts.net:8443",
      ),
    ).toEqual([]);
    // The compose overlays pass SITE_ADDRESS="" to the app.
    expect(
      deploymentUrlWarnings("", "https://morrow.example.ts.net:8443"),
    ).toEqual([]);
  });
});

describe("isPublicOrigin", () => {
  it("treats loopback, LAN, and VPN ranges as private", () => {
    for (const url of [
      "http://localhost:3100",
      "http://app.localhost",
      "http://127.0.0.1:3000",
      "http://192.168.1.10:3100",
      "http://10.0.0.5",
      "http://172.16.4.2",
      "http://172.31.255.1",
      "http://169.254.10.1",
      "http://100.64.0.1",
      "http://morrow.local",
      "http://morrow.home.arpa",
      "http://[::1]:3000",
      "http://[fd7a:115c:a1e0::1]:3000",
    ]) {
      expect(isPublicOrigin(url), url).toBe(false);
    }
  });

  it("treats public hosts and domains as public", () => {
    for (const url of [
      "https://morrow.example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://100.128.0.1",
      "http://morrow.ts.net",
    ]) {
      expect(isPublicOrigin(url), url).toBe(true);
    }
  });
});
