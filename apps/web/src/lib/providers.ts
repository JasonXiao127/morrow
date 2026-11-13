/**
 * M4.1 provider presets, honest copy, and data hooks (apps/web only).
 *
 * Contract (backend landing in parallel — adapt if it drifts; exact shape
 * used): GET /api/providers ->
 * `{ providers: [{ id, providerId, label, kind, baseUrl, models, enabled,
 * connected, keyLast4, lastTestOk, lastError }] }`.
 * Keys are write-only (never echoed); only `keyLast4` is shown masked.
 * Step-up (`POST /api/auth/password`) runs before add/rotate/delete.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiErrorMessage,
  isApiError,
  isMissingRoute,
  providersApi,
  type ApiError,
  type ProviderRecord,
} from "@/api";
import { announce } from "./announce";
import { assistantKeys } from "./assistant";

export const providerKeys = {
  all: ["providers"] as const,
};

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  hint: string;
}

/** Add-wizard presets. Base URLs are prefilled hints; Custom is blank. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    hint: "Your OpenAI API key.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    baseUrl: "https://opencode.ai/api",
    needsKey: true,
    hint: "OpenCode Zen key.",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "http://localhost:4096/v1",
    needsKey: true,
    hint: "Self-hosted sidecar. Adjust the host if it lives elsewhere.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    hint: "One key, many models.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true,
    hint: "DeepSeek API key.",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    hint: "Groq API key.",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    hint: "Local models. No key needed.",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    hint: "Local models. No key needed.",
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    needsKey: true,
    hint: "Any OpenAI-compatible endpoint.",
  },
];

export function presetFor(id: string | undefined): ProviderPreset {
  return (
    PROVIDER_PRESETS.find((preset) => preset.id === id) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  );
}

/** `https://api.openai.com/v1` -> `api.openai.com`; unparseable -> trimmed input. */
export function providerHost(baseUrl: string | null | undefined): string {
  if (!baseUrl) return "no endpoint set";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** `••••abcd`. Local/keyless providers show honest copy instead. */
export function maskedKey(keyLast4: string | null | undefined): string {
  if (!keyLast4) return "no key stored";
  return `••••${keyLast4}`;
}

export type ProviderTone = "success" | "warning" | "muted";

/**
 * Green: enabled, connected, models listed. Warn: enabled but the last test
 * failed or an error is recorded. Muted: disabled (or never confirmed).
 */
export function providerTone(provider: ProviderRecord): ProviderTone {
  if (!provider.enabled) return "muted";
  if (provider.lastTestOk === false || provider.lastError) return "warning";
  if (provider.connected && provider.models.length > 0) return "success";
  if (provider.connected) return "success";
  return "muted";
}

export function providerStateLabel(provider: ProviderRecord): string {
  if (!provider.enabled) return "disabled";
  if (provider.lastTestOk === false || provider.lastError) return "needs attention";
  if (provider.connected) return "connected";
  return "not tested yet";
}

/**
 * Bounded, honest test copy. Maps 401/403/429/timeout to plain language;
 * everything else falls back to the server's message.
 */
export function testErrorCopy(error: unknown): string {
  if (error instanceof TypeError) {
    return "Couldn't reach the provider. Check the endpoint URL and try again.";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The test timed out. The provider may be slow or unreachable — try again.";
  }
  if (isApiError(error)) {
    if (error.status === 401)
      return "That key was rejected (401). Paste a fresh key — keys are never shown again after saving.";
    if (error.status === 403)
      return "The provider refused this key (403). Check the key's permissions, then Test again.";
    if (error.status === 429)
      return "Rate-limited (429). Wait a moment, then Test again.";
    if (error.status >= 500)
      return "The provider hit a problem. Nothing was changed — try again in a bit.";
    return apiErrorMessage(error);
  }
  if (error instanceof Error && error.message) return error.message;
  return "The test didn't pass. Check the endpoint and key, then try again.";
}

export function isProvidersPending(error: unknown): boolean {
  return isMissingRoute(error);
}

export async function refreshProviderViews(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: providerKeys.all }),
    client.invalidateQueries({ queryKey: assistantKeys.status }),
    client.invalidateQueries({ queryKey: assistantKeys.models }),
  ]);
}

export function useProviders(enabled = true) {
  return useQuery({
    queryKey: providerKeys.all,
    queryFn: ({ signal }) => providersApi.list(signal),
    staleTime: 15_000,
    retry: false,
    enabled,
  });
}

export function providersPendingError(
  error: unknown,
): error is ApiError {
  return isProvidersPending(error);
}

export function useToggleProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderRecord) =>
      providersApi.update(provider.id, { enabled: !provider.enabled }),
    onSuccess: async (updated) => {
      await refreshProviderViews(queryClient);
      announce(
        updated.enabled
          ? `Enabled ${updated.label}.`
          : `Disabled ${updated.label}. The assistant stays off until a provider is connected.`,
      );
      toast.success(updated.enabled ? "Provider enabled." : "Provider disabled.", {
        description: updated.enabled
          ? `“${updated.label}” is back in rotation.`
          : "Reminders, tasks, and push are untouched.",
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useTestProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderRecord) => {
      const controller = new AbortController();
      const timeout =
        typeof window !== "undefined" && typeof window.setTimeout === "function"
          ? window.setTimeout(() => controller.abort(), 25_000)
          : undefined;
      return providersApi
        .test(provider.id, controller.signal)
        .finally(() => {
          if (timeout !== undefined) window.clearTimeout(timeout);
        });
    },
    onSuccess: async (result, provider) => {
      await refreshProviderViews(queryClient);
      if (result.ok) {
        const count = result.models?.length;
        announce(`Test passed for ${provider.label}.`);
        toast.success("Test passed.", {
          description:
            typeof count === "number"
              ? `“${provider.label}” answered${count > 0 ? ` with ${count} model${count === 1 ? "" : "s"}` : ""}. Capture it, sort it later.`
              : `“${provider.label}” answered.`,
        });
      } else {
        toast.error("Test failed.", {
          description:
            typeof result.error === "string" && result.error
              ? result.error
              : "The provider answered with an error. Check the endpoint and key.",
        });
      }
    },
    onError: (error, provider) => {
      toast.error("Test failed.", {
        description: `${testErrorCopy(error)} (provider “${provider.label}”)`,
      });
    },
  });
}

export function useDiscoverProviderModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderRecord) => {
      const controller = new AbortController();
      const timeout =
        typeof window !== "undefined" && typeof window.setTimeout === "function"
          ? window.setTimeout(() => controller.abort(), 25_000)
          : undefined;
      return providersApi
        .discoverModels(provider.id, controller.signal)
        .finally(() => {
          if (timeout !== undefined) window.clearTimeout(timeout);
        });
    },
    onSuccess: async (result, provider) => {
      await refreshProviderViews(queryClient);
      announce(
        result.models.length > 0
          ? `${provider.label} lists ${result.models.length} models.`
          : `No models listed for ${provider.label}.`,
      );
      toast.success(
        result.models.length > 0
          ? `Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`
          : "No models listed.",
        {
          description:
            result.models.length > 0
              ? `“${provider.label}” refreshed. Pick one in Chat model above.`
              : `“${provider.label}” answered but listed nothing. Add model IDs by hand.`,
        },
      );
    },
    onError: (error) => toast.error(testErrorCopy(error)),
  });
}
