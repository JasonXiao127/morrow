import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiErrorMessage,
  assistantApi,
  proposalsApi,
  type AssistantStatus,
  type Proposal,
} from "@/api";
import { invalidateTaskQueries, queryKeys } from "./query";

export const assistantKeys = {
  status: ["assistant", "status"] as const,
  models: ["assistant", "models"] as const,
  proposals: (status: string) => ["proposals", status] as const,
};

export function useAssistantStatus(enabled = true) {
  return useQuery({
    queryKey: assistantKeys.status,
    queryFn: () => assistantApi.status(),
    staleTime: 15_000,
    retry: false,
    enabled,
  });
}

export function useAssistantModels(enabled = true) {
  return useQuery({
    queryKey: assistantKeys.models,
    queryFn: () => assistantApi.models(),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

export function useProposals(status = "pending", enabled = true) {
  return useQuery({
    queryKey: assistantKeys.proposals(status),
    queryFn: () => proposalsApi.list({ status, limit: 50 }),
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
    // Proposals are owner-only; members must not fire a guaranteed 403 on
    // every Today load.
    enabled,
  });
}

export function usePendingProposals() {
  return useProposals("pending");
}

export function useApplyProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      proposal,
      operations,
      payloadHash,
    }: {
      proposal: Proposal;
      operations?: number[];
      payloadHash?: string;
    }) =>
      proposalsApi.apply(proposal.id, {
        operations,
        payloadHash,
        baseRev: proposal.baseRev ?? undefined,
      }),
    onSuccess: async (result) => {
      await Promise.all([
        invalidateTaskQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
      ]);
      toast.success(
        result.applied === 1
          ? "Applied 1 change."
          : `Applied ${result.applied} changes.`,
        {
          description: "Undo all is available on the proposal card.",
        },
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useDismissProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposal: Proposal) => proposalsApi.dismiss(proposal.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["proposals"] });
      toast("Proposal dismissed", {
        description: "Nothing changed.",
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useUndoProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (proposal: Proposal) => proposalsApi.undo(proposal.id),
    onSuccess: async (result) => {
      await Promise.all([
        invalidateTaskQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
      ]);
      toast.success("Undone.", {
        description: `${result.undone} change${result.undone === 1 ? "" : "s"} restored.`,
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function usePlanMyDay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { timezone?: string; conversationId?: string | null } = {}) =>
      assistantApi.planMyDay(input),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
        invalidateTaskQueries(queryClient),
      ]);
      if (!result.proposal) {
        toast(result.summary);
      } else {
        toast("A plan is ready", {
          description: result.summary,
        });
      }
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useAssistantSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      aiEnabled?: boolean;
      model?: string | null;
      fallbackModel?: string | null;
    }) => assistantApi.updateSettings(patch),
    onSuccess: async (result) => {
      queryClient.setQueryData(assistantKeys.status, result);
      await queryClient.invalidateQueries({ queryKey: assistantKeys.models });
      toast.success("Assistant settings saved.", {
        description:
          result.status.status === "ready"
            ? "Ready to chat."
            : (result.status.message ?? "Status updated."),
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useUndoBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => assistantApi.undoBatch(batchId),
    onSuccess: async (result) => {
      await Promise.all([
        invalidateTaskQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
      ]);
      toast.success("Undone.", {
        description: `${result.undone} change${result.undone === 1 ? "" : "s"} restored.`,
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function statusLabel(status: AssistantStatus | undefined): string {
  if (!status) return "Checking…";
  if (status.status === "ready") return "Connected";
  if (status.status === "disabled") return "Off · optional";
  if (status.status === "not_configured") return "Off · optional";
  if (status.status === "model_missing") return "Model needed";
  if (status.status === "model_not_tool_capable") return "Model needs tools";
  if (status.status === "unreachable") return "Sidecar offline";
  if (status.status === "contract_mismatch") return "Version mismatch";
  return status.status;
}

export function canChat(status: AssistantStatus | undefined): boolean {
  return Boolean(status?.available && status.status === "ready");
}

export { queryKeys };
