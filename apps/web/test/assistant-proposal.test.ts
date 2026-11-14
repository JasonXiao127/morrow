import { describe, expect, it } from "vitest";
import type { Proposal } from "@/api";
import {
  isProposalUndone,
  proposalCardSummary,
  proposalStateLabel,
} from "../src/lib/assistant.js";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    conversationId: "conv-1",
    summary: "Suggested changes",
    operations: [],
    baseRev: null,
    payloadHash: "a".repeat(64),
    expiresAt: "2026-11-15T00:00:00.000Z",
    status: "pending",
    appliedRev: null,
    appliedActivityId: null,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    rev: 1,
    preview: [],
    ...overrides,
  };
}

describe("proposal presentation state", () => {
  it("distinguishes a real dismissal from undo-after-apply", () => {
    const dismissed = proposal({ status: "dismissed" });
    const undone = proposal({
      status: "dismissed",
      appliedActivityId: 42,
    });

    expect(isProposalUndone(dismissed)).toBe(false);
    expect(proposalStateLabel(dismissed)).toBe("dismissed");
    expect(proposalCardSummary(dismissed)).toBe(
      "Dismissed. Nothing changed.",
    );

    expect(isProposalUndone(undone)).toBe(true);
    expect(proposalStateLabel(undone)).toBe("undone");
    expect(proposalCardSummary(undone)).toBe(
      "Undone. The previous state was restored.",
    );
  });

  it("keeps applied and expired copy accurate", () => {
    expect(
      proposalCardSummary(proposal({ status: "applied" })),
    ).toBe("Applied. Undo all restores the previous state.");
    expect(
      proposalCardSummary(proposal({ status: "expired" })),
    ).toBe("Expired. Ask again for a fresh plan.");
    expect(proposalCardSummary(proposal())).toBe("Suggested changes");
  });
});
