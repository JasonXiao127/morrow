import { afterEach, describe, expect, it, vi } from "vitest";
import { pushSecureContext } from "@/lib/push";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push secure context", () => {
  it("is false when there is no window", () => {
    expect(pushSecureContext()).toBe(false);
  });

  it("reflects window.isSecureContext", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    expect(pushSecureContext()).toBe(true);

    vi.stubGlobal("window", { isSecureContext: false });
    expect(pushSecureContext()).toBe(false);
  });
});
