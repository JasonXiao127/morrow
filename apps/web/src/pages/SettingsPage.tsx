import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import * as Switch from "@radix-ui/react-switch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Bot,
  CloudDownload,
  Database,
  HardDrive,
  Info,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Smartphone,
  Sun,
  Tag as TagIcon,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage, authApi, backupApi, providersApi, userApi, type ProviderRecord } from "@/api";
import { DialogFrame } from "@/components/DialogFrame";
import { announce } from "@/lib/announce";
import { InstallHelp } from "@/components/InstallHelp";
import { UpdateAvailable } from "@/components/UpdateAvailable";
import {
  BackupRestorePanel,
  CalendarIntegrationPanel,
  CaptureTokensPanel,
  DigestPanel,
  NtfyPanel,
  PasswordPanel,
  PeoplePanel,
  QuietHoursPanel,
  SessionsPanel,
  TagsSettingsPanel,
} from "@/components/SettingsExtras";
import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/components/shell-context";
import { statusToneForPermission } from "@/lib/status";
import { useOnline } from "@/lib/hooks";
import { isLocalhostOrigin, usePushStatus } from "@/lib/push";
import { useAppData, useUpdateSettings } from "@/lib/queries";
import { queryKeys } from "@/lib/query";
import {
  statusLabel,
  useAssistantModels,
  useAssistantSettings,
  useAssistantStatus,
} from "@/lib/assistant";
import {
  maskedKey,
  presetFor,
  providerHost,
  providerStateLabel,
  providerTone,
  PROVIDER_PRESETS,
  refreshProviderViews,
  testErrorCopy,
  useDiscoverProviderModels,
  useProviders,
  useTestProvider,
  useToggleProvider,
  providersPendingError,
} from "@/lib/providers";
import { endSession } from "@/lib/session";
import { useTheme, type ThemePreference } from "@/lib/theme";
import {
  detectedTimezone,
  localTimeFor,
  timezoneList,
} from "@/lib/timezone";
import { cn, initials } from "@/lib/utils";
import { userDisplayName } from "@/lib/format";

type SettingsSection =
  | "account"
  | "timezone"
  | "ai"
  | "devices"
  | "tags"
  | "integrations"
  | "backup"
  | "about";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: ReactNode;
}> = [
  { id: "account", label: "Account", icon: <UserRound className="h-4 w-4" /> },
  { id: "timezone", label: "Timezone", icon: <Palette className="h-4 w-4" /> },
  { id: "ai", label: "AI", icon: <Bot className="h-4 w-4" /> },
  { id: "devices", label: "Devices & notifications", icon: <Bell className="h-4 w-4" /> },
  { id: "tags", label: "Tags", icon: <TagIcon className="h-4 w-4" /> },
  { id: "integrations", label: "Integrations", icon: <KeyRound className="h-4 w-4" /> },
  { id: "backup", label: "Backup", icon: <HardDrive className="h-4 w-4" /> },
  { id: "about", label: "About", icon: <Info className="h-4 w-4" /> },
];

/** Global settings the server also restricts to the workspace owner. */
const OWNER_ONLY_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  "timezone",
  "ai",
  "backup",
]);

function isSection(value: string | null): value is SettingsSection {
  return SECTIONS.some((section) => section.id === value);
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-hairline bg-surface p-4 md:p-5">
      <h3 className="text-13 font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1 text-12 leading-relaxed text-muted">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function OwnerOnlyNotice({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="serif text-22">{title}</h2>
        <p className="mt-1 text-13 text-muted">
          This section changes workspace-global settings, so only the owner can
          open it. Your tasks, lists, sharing, capture tokens, and devices keep
          working normally.
        </p>
      </div>
      <Panel title="Owner only">
        <div className="flex items-start gap-2 text-13 leading-relaxed text-muted">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-muted"
            aria-hidden="true"
          />
          <p>
            Ask the workspace owner if a global setting needs to change. The
            server enforces this even if this page is opened directly.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function Row({
  label,
  value,
  status,
}: {
  label: string;
  value: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline py-2.5 text-13 last:border-b-0">
      <span className="w-40 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-ink-soft">{value}</span>
      {status}
    </div>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted";
  children: ReactNode;
}) {
  const tones = {
    success: "border-success/30 bg-success-soft text-success",
    warning: "border-warning/30 bg-warning-soft text-warning",
    danger: "border-danger/30 bg-danger-soft text-danger",
    muted: "border-hairline bg-canvas text-muted",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-12",
        tones[tone],
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* M4.1 AI providers (apps/web only)                                         */
/*                                                                           */
/* Contract used (backend landing in parallel — adapts if it drifts):        */
/* GET /api/providers -> { providers: [{ id, providerId, label, kind,        */
/* baseUrl, models, enabled, connected, keyLast4, lastTestOk, lastError }] }. */
/* Keys are write-only; only `keyLast4` is shown, masked. Step-up           */
/* (POST /api/auth/password) runs before add/rotate/delete.                  */
/* -------------------------------------------------------------------------- */

function boundedSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => window.clearTimeout(timer),
  };
}

function parseModelIds(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((model) => model.trim())
    .filter(Boolean);
}

function ProviderSection() {
  const queryClient = useQueryClient();
  const providersQuery = useProviders(true);
  const toggle = useToggleProvider();
  const test = useTestProvider();
  const discover = useDiscoverProviderModels();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRecord | null>(null);
  const [removing, setRemoving] = useState<ProviderRecord | null>(null);
  const [actionPassword, setActionPassword] = useState("");

  const withStepUp = async (action: () => void): Promise<void> => {
    if (!actionPassword) {
      toast.error("Enter your Morrow password first.", {
        description: "Test, refresh, and enable/disable need a fresh step-up.",
      });
      return;
    }
    try {
      await authApi.stepUp(actionPassword);
      action();
    } catch {
      toast.error("That password didn't match.");
    }
  };

  const providers = useMemo(
    () => providersQuery.data?.providers ?? [],
    [providersQuery.data],
  );
  const pending = providersQuery.isError
    ? providersPendingError(providersQuery.error)
    : false;

  const openAdd = () => {
    setEditing(null);
    setWizardOpen(true);
  };
  const openRotate = (provider: ProviderRecord) => {
    setEditing(provider);
    setWizardOpen(true);
  };

  return (
    <Panel
      title="Providers"
      description="Bring your own key. Reminders, tasks, and push work fine with AI switched off — providers only power the assistant."
    >
      {pending ? (
        <div
          className="rounded-md border border-dashed border-hairline-strong bg-canvas px-3 py-3 text-12 leading-relaxed text-muted"
          role="note"
        >
          <p className="font-semibold text-ink-soft">
            Provider settings are PENDING on this server.
          </p>
          <p className="mt-1">
            This build doesn&apos;t expose{" "}
            <code className="mono">/api/providers</code> yet, so nothing here
            is live and nothing was saved. Configure a provider with{" "}
            <code className="mono text-12">
              docker compose exec -it opencode opencode auth login
            </code>
            , then reload this page.
          </p>
        </div>
      ) : providersQuery.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          <div className="skeleton h-11 w-full" />
          <div className="skeleton h-11 w-full" />
        </div>
      ) : providersQuery.isError ? (
        <div role="alert" className="text-12 leading-relaxed text-danger">
          <p>Couldn&apos;t load providers: {apiErrorMessage(providersQuery.error)}</p>
          <button
            type="button"
            className="btn btn-secondary mt-2"
            onClick={() => void providersQuery.refetch()}
          >
            Try again
          </button>
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-md border border-hairline bg-canvas px-3 py-3 text-12 leading-relaxed text-muted">
          <p>
            No providers yet. The assistant stays off — everything else works.
            Capture it, sort it later.
          </p>
          <p className="mt-1">
            ChatGPT Plus and Copilot stay CLI-only: they can&apos;t be added
            here. Connect them on the host with{" "}
            <code className="mono">opencode auth login</code>; API keys go
            through Add provider below.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--hairline)] rounded-md border border-hairline">
          {providers.map((provider) => {
            const tone = providerTone(provider);
            const busyRow =
              (toggle.isPending && toggle.variables?.id === provider.id) ||
              (test.isPending && test.variables?.id === provider.id) ||
              (discover.isPending && discover.variables?.id === provider.id);
            return (
              <li key={provider.id} className="px-3 py-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      tone === "success" && "bg-success",
                      tone === "warning" && "bg-warning",
                      tone === "muted" && "bg-[var(--hairline-strong)]",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-13 font-semibold text-ink">
                      {provider.label}
                    </p>
                    <p className="truncate text-12 text-muted">
                      {providerHost(provider.baseUrl)} ·{" "}
                      {provider.models.length}{" "}
                      {provider.models.length === 1 ? "model" : "models"} ·{" "}
                      <span className="mono">{maskedKey(provider.keyLast4)}</span>
                    </p>
                  </div>
                  <StatusPill tone={tone}>{providerStateLabel(provider)}</StatusPill>
                  <Switch.Root
                    checked={provider.enabled}
                    disabled={toggle.isPending}
                    onCheckedChange={() =>
                      void withStepUp(() => toggle.mutate(provider))
                    }
                    aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.label}`}
                    className="relative h-6 w-10 shrink-0 rounded-full bg-hairline-strong before:absolute before:-inset-[10px] before:content-[''] data-[state=checked]:bg-accent disabled:opacity-60"
                  >
                    <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-canvas transition-transform data-[state=checked]:translate-x-[18px]" />
                  </Switch.Root>
                </div>
                {provider.lastError && provider.enabled ? (
                  <p className="mt-2 text-12 leading-relaxed text-warning" role="note">
                    Last test: {provider.lastError}{" "}
                    <button
                      type="button"
                      className="font-semibold underline underline-offset-2"
                      onClick={() =>
                        void withStepUp(() => test.mutate(provider))
                      }
                      disabled={busyRow}
                    >
                      Test again
                    </button>
                  </p>
                ) : null}
                <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost min-h-11 px-2 text-12"
                    onClick={() =>
                      void withStepUp(() => test.mutate(provider))
                    }
                    disabled={busyRow}
                    aria-busy={test.isPending && test.variables?.id === provider.id}
                  >
                    {test.isPending && test.variables?.id === provider.id
                      ? "Testing…"
                      : "Test"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost min-h-11 px-2 text-12"
                    onClick={() =>
                      void withStepUp(() => discover.mutate(provider))
                    }
                    disabled={busyRow}
                    title="Refresh the model list from this provider"
                  >
                    {discover.isPending && discover.variables?.id === provider.id
                      ? "Reading…"
                      : "Refresh models"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost min-h-11 px-2 text-12"
                    onClick={() => openRotate(provider)}
                  >
                    Rotate key
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost min-h-11 px-2 text-12 text-danger"
                    onClick={() => setRemoving(provider)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {providers.length > 0 ? (
        <div className="mt-3">
          <label htmlFor="provider-action-password" className="field-label">
            Morrow password (for Test / Refresh / Enable)
          </label>
          <input
            id="provider-action-password"
            type="password"
            className="input"
            value={actionPassword}
            onChange={(event) => setActionPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Your Morrow password"
          />
          <p className="field-help">
            These actions need a fresh step-up confirmation. Enter your password
            once; it stays in this page only.
          </p>
        </div>
      ) : null}

      {!pending && !providersQuery.isError ? (
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={openAdd}
            disabled={providersQuery.isPending}
          >
            Add provider
          </button>
          {providers.length > 0 ? (
            <p className="field-help">
              ChatGPT Plus and Copilot stay CLI-only — connect those on the
              host with <code className="mono">opencode auth login</code>. API
              keys added here refresh the Chat model list above.
            </p>
          ) : null}
        </div>
      ) : null}

      {wizardOpen ? (
        <ProviderWizard
          key={editing?.id ?? "new"}
          editing={editing}
          onClose={() => setWizardOpen(false)}
          onSaved={() => {
            setWizardOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["assistant"] });
          }}
        />
      ) : null}

      <ProviderRemoveDialog
        target={removing}
        isLast={providers.length <= 1}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          void refreshProviderViews(queryClient);
        }}
      />
    </Panel>
  );
}

function ProviderWizard({
  editing,
  onClose,
  onSaved,
}: {
  editing: ProviderRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const initialPreset = presetFor(editing?.providerId);
  const [presetId, setPresetId] = useState(initialPreset.id);
  const preset = presetFor(presetId);
  const [step, setStep] = useState<"pick" | "fields">(editing ? "fields" : "pick");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? initialPreset.baseUrl);
  const [modelsText, setModelsText] = useState((editing?.models ?? []).join("\n"));
  const [keyValue, setKeyValue] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [stepUp, setStepUp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const pickPreset = (id: string) => {
    const next = presetFor(id);
    const prev = presetFor(presetId);
    setPresetId(id);
    // Prefill the endpoint; keep a hand-edited URL when it no longer matches
    // the previous preset. Custom stays blank for a hand-typed URL.
    setBaseUrl((current) => {
      if (id === "custom") return "";
      if (!current.trim() || current.trim() === prev.baseUrl) return next.baseUrl;
      return current;
    });
    if (!label.trim()) setLabel(next.label);
    setStep("fields");
  };

  const runTest = async (id: string): Promise<boolean> => {
    setTesting(true);
    setError(null);
    try {
      const bounded = boundedSignal(25_000);
      try {
        const result = await providersApi.test(id, bounded.signal);
        if (result.ok) {
          const count = result.models?.length;
          setNotice(
            typeof count === "number" && count > 0
              ? `Test passed — the provider answered with ${count} model${count === 1 ? "" : "s"}.`
              : "Test passed — the provider answered.",
          );
          try {
            await providersApi.discoverModels(id);
          } catch {
            // Best effort: the test already passed.
          }
          await refreshProviderViews(queryClient);
          announce("Provider test passed.");
          return true;
        }
        setError(
          typeof result.error === "string" && result.error
            ? result.error
            : "The provider answered with an error. Check the endpoint and key.",
        );
        return false;
      } finally {
        bounded.done();
      }
    } catch (caught) {
      setError(testErrorCopy(caught));
      return false;
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl) {
      setError("Add the endpoint URL — Custom needs a hand-typed one.");
      return;
    }
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setError("That endpoint URL should start with http:// or https://.");
        return;
      }
    } catch {
      setError("That endpoint URL doesn't parse — it should start with http:// or https://.");
      return;
    }
    if (!editing && preset.needsKey && !keyValue) {
      setError("Paste a key — it stays write-only and is never shown again.");
      return;
    }
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        const parsed: unknown = JSON.parse(headersText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      } catch {
        setError('Headers must be a flat JSON object, e.g. {"X-Team": "home"}.');
        return;
      }
    }
    if (!stepUp) {
      setError("Enter your Morrow password — adding a provider needs a fresh confirmation (step-up).");
      return;
    }
    setBusy(true);
    try {
      // Step-up first: the server rejects add/rotate without it.
      try {
        await authApi.stepUp(stepUp);
      } catch {
        setError("That password didn't match — the provider wasn't saved.");
        return;
      }
      const models = parseModelIds(modelsText);
      let saved: ProviderRecord;
      if (editing) {
        saved = await providersApi.update(editing.id, {
          label: label.trim() || editing.label,
          baseUrl: trimmedUrl,
          models,
          ...(keyValue ? { key: keyValue } : {}),
          ...(headers ? { headers } : {}),
        });
      } else {
        saved = await providersApi.create({
          kind: preset.id === "custom" ? "custom" : "preset",
          ...(preset.id === "custom" ? {} : { preset: preset.id }),
          label: label.trim() || preset.label,
          baseUrl: trimmedUrl,
          models,
          ...(keyValue ? { key: keyValue } : {}),
          ...(headers ? { headers } : {}),
        });
      }
      await refreshProviderViews(queryClient);
      setNotice("Saved. Testing the connection…");
      const ok = await runTest(saved.id);
      if (ok) {
        toast.success(editing ? "Key rotated." : "Provider saved.", {
          description: `“${saved.label}” connected. The Chat model list above just refreshed — pick a model there.`,
        });
        announce(editing ? `Key rotated for ${saved.label}.` : `Provider ${saved.label} saved.`);
        onSaved();
      } else {
        toast.error(editing ? "Saved, but the test failed." : "Saved, but the test failed.", {
          description: "The provider is stored. Fix the key or endpoint, then Test again.",
        });
      }
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      open
      onOpenChange={(open) => {
        if (!open && !busy && !testing) onClose();
      }}
      title={editing ? `Rotate key for ${editing.label}` : "Add provider"}
      description={
        editing
          ? "Replace the stored key. The old key is discarded; the new one is never shown again."
          : "Pick a preset, paste a key, save with a password confirmation."
      }
    >
      <div className="max-h-[80dvh] overflow-y-auto p-5 md:p-6">
        <h2 className="serif text-22">
          {editing ? `Rotate key · ${editing.label}` : "Add provider"}
        </h2>
        <p className="mt-1 text-13 leading-relaxed text-muted">
          {editing
            ? "Leave the key blank to keep the current one. Saving still needs your password."
            : "Keys stay write-only — Morrow shows only the last four characters, never the key."}
        </p>

        {step === "pick" && !editing ? (
          <div className="mt-4">
            <p className="field-label" id="provider-preset-label">
              Preset
            </p>
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              role="group"
              aria-labelledby="provider-preset-label"
            >
              {PROVIDER_PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pickPreset(item.id)}
                  aria-pressed={presetId === item.id}
                  className="flex min-h-11 flex-col items-start justify-center gap-0.5 rounded-md border border-hairline bg-canvas px-3 py-2 text-left hover:border-hairline-strong aria-pressed:border-accent aria-pressed:bg-accent-soft"
                >
                  <span className="text-13 font-semibold text-ink">{item.label}</span>
                  <span className="text-12 text-muted">
                    {item.needsKey ? "API key" : "No key"}
                  </span>
                </button>
              ))}
            </div>
            <p className="field-help">{preset.hint}</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {!editing ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-13 font-semibold text-ink">
                  Preset · {preset.label}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 px-2 text-12"
                  onClick={() => setStep("pick")}
                >
                  Change preset
                </button>
              </div>
            ) : null}
            <div>
              <label htmlFor="provider-label" className="field-label">
                Label
              </label>
              <input
                id="provider-label"
                className="input"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={preset.label}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="provider-baseurl" className="field-label">
                Endpoint URL
              </label>
              <input
                id="provider-baseurl"
                className="input mono text-13"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://…/v1"
                autoComplete="off"
                inputMode="url"
              />
              <p className="field-help">
                Prefilled from the preset{preset.id === "custom" ? " — type any OpenAI-compatible endpoint" : " — edit it for a self-hosted host"}.
              </p>
            </div>
            <div>
              <label htmlFor="provider-models" className="field-label">
                Model IDs <span className="font-normal text-muted">(one per line, optional)</span>
              </label>
              <textarea
                id="provider-models"
                className="textarea mono text-13"
                value={modelsText}
                onChange={(event) => setModelsText(event.target.value)}
                placeholder={"gpt-4o-mini\nclaude-sonnet-4-5"}
                rows={3}
              />
              <p className="field-help">
                Leave blank to pull the list from the provider after saving (Refresh models).
              </p>
            </div>
            <div>
              <label htmlFor="provider-key" className="field-label">
                {editing ? "New key (rotates the stored key)" : "API key"}
                {preset.needsKey && !editing ? null : (
                  <span className="font-normal text-muted"> — optional for local endpoints</span>
                )}
              </label>
              <input
                id="provider-key"
                type="password"
                className="input mono text-13"
                value={keyValue}
                onChange={(event) => setKeyValue(event.target.value)}
                autoComplete="new-password"
                placeholder={editing ? "Leave blank to keep the current key" : "sk-… (never shown again)"}
              />
              <p className="field-help">
                Write-only. Morrow stores it server-side and shows only{" "}
                <span className="mono">••••last4</span> afterwards.
              </p>
            </div>
            <details className="rounded-md border border-hairline bg-canvas px-3 py-2">
              <summary className="min-h-11 cursor-pointer text-13 font-semibold text-ink-soft">
                Advanced headers (optional)
              </summary>
              <label htmlFor="provider-headers" className="field-label mt-2">
                Extra headers as JSON
              </label>
              <textarea
                id="provider-headers"
                className="textarea mono text-13"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={'{"X-Team": "home"}'}
                rows={2}
              />
            </details>
            <div>
              <label htmlFor="provider-stepup" className="field-label">
                Morrow password (step-up)
              </label>
              <input
                id="provider-stepup"
                type="password"
                className="input"
                value={stepUp}
                onChange={(event) => setStepUp(event.target.value)}
                autoComplete="current-password"
                placeholder="Confirms it is really you"
              />
              <p className="field-help">
                Adding or rotating a key needs a fresh confirmation — your session alone is not enough.
              </p>
            </div>
            {editing ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void runTest(editing.id)}
                  disabled={busy || testing}
                  aria-busy={testing}
                >
                  {testing ? "Testing…" : "Test current connection"}
                </button>
              </div>
            ) : null}
          </div>
        )}

        <div aria-live="polite">
          {notice ? (
            <p className="mt-3 rounded-md border border-hairline bg-canvas px-3 py-2 text-12 leading-relaxed text-muted">
              {notice}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-13 leading-relaxed text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy || testing}
          >
            Cancel
          </button>
          {step === "fields" || editing ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={busy || testing}
              aria-busy={busy}
            >
              {busy ? "Saving…" : editing ? "Rotate key" : "Save provider"}
            </button>
          ) : null}
        </div>
      </div>
    </DialogFrame>
  );
}

function ProviderRemoveDialog({
  target,
  isLast,
  onClose,
  onRemoved,
}: {
  target: ProviderRecord | null;
  isLast: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expected = target?.label ?? "";
  const confirmOk = expected.length > 0 && confirm.trim() === expected.trim();

  const remove = async () => {
    if (!target) return;
    if (!confirmOk) {
      setError(`Type “${expected}” to confirm.`);
      return;
    }
    if (!password) {
      setError("Enter your password — removing a provider needs a fresh confirmation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Step-up first: DELETE returns 403 step_up_required without it.
      try {
        await authApi.stepUp(password);
      } catch {
        setError("That password didn't match — nothing was removed.");
        return;
      }
      await providersApi.remove(target.id);
      announce(`Removed provider ${target.label}.`);
      toast.success("Provider removed.", {
        description: isLast
          ? "That was the last one — the assistant is off · optional again. Reminders, tasks, and push are untouched."
          : `“${target.label}” is gone. Reminders, tasks, and push are untouched.`,
      });
      onRemoved();
      onClose();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setConfirm("");
          setPassword("");
          setError(null);
          onClose();
        }
      }}
      title={target ? `Remove ${target.label}` : "Remove provider"}
      description="Removing a provider drops its stored key. A typed confirmation plus password is required."
    >
      {target ? (
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">Remove “{target.label}”?</h2>
          <p className="mt-2 text-13 leading-relaxed text-muted">
            This drops the stored key and its {target.models.length}{" "}
            {target.models.length === 1 ? "model" : "models"}. Nothing else
            changes — tasks, reminders, and push keep working
            {isLast
              ? ", and the assistant returns to off · optional."
              : "."}{" "}
            Removing needs a typed confirmation plus a fresh password (step-up)
            — your session alone is not enough.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="provider-remove-confirm" className="field-label">
                Type “{expected}” to confirm
              </label>
              <input
                id="provider-remove-confirm"
                className="input mono text-13"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                placeholder={expected}
              />
            </div>
            <div>
              <label htmlFor="provider-remove-password" className="field-label">
                Password (step-up)
              </label>
              <input
                id="provider-remove-password"
                type="password"
                className="input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Your Morrow password"
              />
            </div>
            {error ? (
              <p role="alert" className="text-13 leading-relaxed text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void remove()}
              disabled={busy || !confirmOk || !password}
              aria-busy={busy}
            >
              {busy ? "Removing…" : "Remove provider"}
            </button>
          </div>
        </div>
      ) : null}
    </DialogFrame>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const searchString = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const requestedSection = new URLSearchParams(searchString).get("section");
  const section: SettingsSection = isSection(requestedSection)
    ? requestedSection
    : "account";

  const { user, settings } = useAppData();
  const isOwner = user?.role === "owner";
  const visibleSections = SECTIONS.filter(
    (item) => isOwner || !OWNER_ONLY_SECTIONS.has(item.id),
  );
  const { openAssistant } = useShell();
  const queryClient = useQueryClient();
  const updateSettings = useUpdateSettings();
  const push = usePushStatus();
  const online = useOnline();
  const [isLocalhost] = useState(isLocalhostOrigin);
  const { preference, setPreference } = useTheme();
  const zones = useMemo(timezoneList, []);
  const detected = useMemo(detectedTimezone, []);

  const [timezone, setTimezone] = useState(
    () => settings.timezone || detected,
  );
  const [accountTimezone, setAccountTimezone] = useState(
    () => user?.timezone || detected,
  );
  const [assistantPassword, setAssistantPassword] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const assistantStatusQuery = useAssistantStatus(isOwner);
  const assistantStatus = assistantStatusQuery.data?.status;
  const assistantModelsQuery = useAssistantModels(
    Boolean(assistantStatus?.enabled),
  );
  const assistantSettings = useAssistantSettings();
  const [aiModel, setAiModel] = useState("");
  const [aiFallbackModel, setAiFallbackModel] = useState("");

  useEffect(() => {
    setTimezone(settings.timezone || detected);
  }, [detected, settings.timezone]);

  useEffect(() => {
    setAccountTimezone(user?.timezone || detected);
  }, [detected, user?.timezone]);

  const saveAssistantSettings = async (patch: {
    aiEnabled?: boolean;
    model?: string | null;
    fallbackModel?: string | null;
  }): Promise<void> => {
    if (!assistantPassword) {
      toast.error("Enter your Morrow password first.", {
        description: "Assistant changes need a fresh step-up.",
      });
      return;
    }
    try {
      await authApi.stepUp(assistantPassword);
      await assistantSettings.mutateAsync(patch);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  const updateMyTimezone = useMutation({
    mutationFn: (next: string) => userApi.updateTimezone(next),
    onSuccess: async () => {
      toast.success("Account timezone saved.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
    },
    onError: (error: unknown) => {
      toast.error(apiErrorMessage(error));
    },
  });

  useEffect(() => {
    setAiModel(assistantStatus?.model ?? "");
  }, [assistantStatus?.model]);

  useEffect(() => {
    setAiFallbackModel(assistantStatus?.fallbackModel ?? "");
  }, [assistantStatus?.fallbackModel]);

  const goToSection = (next: SettingsSection) => {
    void navigate({
      to: "/settings",
      search: { section: next },
      replace: true,
    });
  };

  const saveTimezone = async () => {
    try {
      await updateSettings.mutateAsync({ timezone });
    } catch {
      // The mutation surfaces a toast.
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await endSession();
      toast.success("Signed out.");
      void navigate({ to: "/login", replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  const [testBusy, setTestBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotPassword, setSnapshotPassword] = useState("");
  const [backupRuns, setBackupRuns] = useState<
    Array<{ id: string; name: string; createdAt: string; status: string }>
  >([]);
  const [backupRunsPending, setBackupRunsPending] = useState(false);

  const refreshBackupRuns = async () => {
    setBackupRunsPending(true);
    try {
      const result = await backupApi.runs();
      setBackupRuns(result.runs ?? []);
    } catch {
      // Backup ledger is best-effort; export still works without it.
    } finally {
      setBackupRunsPending(false);
    }
  };

  useEffect(() => {
    // Backup is owner-only. A member deep link must not fire /api/backup/runs.
    if (isOwner && section === "backup") void refreshBackupRuns();
  }, [isOwner, section]);

  const downloadBackup = async () => {
    if (!snapshotPassword) {
      toast.error("Confirm your password first.", {
        description: "Downloads need a fresh step-up. Enter your password below.",
      });
      return;
    }
    try {
      await authApi.stepUp(snapshotPassword);
      window.location.assign("/api/backup/export");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  const runSnapshotNow = async () => {
    if (snapshotBusy) return;
    setSnapshotBusy(true);
    try {
      try {
        await backupApi.run();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "step_up_required"
        ) {
          if (!snapshotPassword) {
            toast.error("Confirm your password first.", {
              description: "Enter your Morrow password below, then Snapshot now.",
            });
            return;
          }
          await authApi.stepUp(snapshotPassword);
          setSnapshotPassword("");
          await backupApi.run();
        } else {
          throw error;
        }
      }
      await Promise.all([queryClient.invalidateQueries(), refreshBackupRuns()]);
      toast.success("Snapshot saved.", {
        description: "A fresh backup is recorded below.",
      });
      announce("Backup snapshot saved.");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setSnapshotBusy(false);
    }
  };

  const enableNotifications = async () => {
    // Never re-prompt after denial: Notification.requestPermission() after a
    // denial is a no-op in most browsers and an annoyance in all of them.
    if (push.permission === "denied") return;
    const result = await push.requestPermission();
    if (result === "granted") {
      await push.refresh();
      if (push.subscribed) {
        toast("Notifications allowed", {
          description: "This device is registered. Send a test ping to confirm.",
        });
      } else {
        toast("Notifications allowed", {
          description:
            "Permission granted but registration is missing — use “Finish device registration”.",
        });
      }
    } else if (result === "denied") {
      toast.error("Push is off", {
        description:
          "Re-enable notifications in your browser’s site settings, then return here.",
      });
    }
  };

  const finishRegistration = async () => {
    const subscription = await push.subscribe();
    await push.refresh();
    if (subscription) {
      toast.success("Device registered.", {
        description: "Send a test ping to confirm delivery.",
      });
    } else {
      toast.error("Registration failed", {
        description:
          push.error ??
          "Push permission was not granted or no service worker is active.",
      });
    }
  };

  const removeDevice = async () => {
    const removed = await push.unsubscribe();
    await push.refresh();
    if (removed) {
      toast.success("Device removed.", {
        description: "This browser will no longer receive pushes.",
      });
    } else {
      toast.error("Could not remove this device.", {
        description: push.error ?? undefined,
      });
    }
  };

  const sendTestPing = async () => {
    setTestBusy(true);
    try {
      const result = await push.sendTest();
      const sent = result.sent ?? 0;
      const failed = result.failed ?? 0;
      const disabled = result.disabled ?? 0;
      if (sent > 0) {
        toast.success(`Test push sent to ${sent} ${sent === 1 ? "device" : "devices"}.`, {
          description:
            failed + disabled > 0
              ? `${failed} failed, ${disabled} disabled. Check the ledger on a task.`
              : "It should arrive within seconds. Check the ledger on a task.",
        });
      } else {
        toast.error("Test push did not send.", {
          description:
            failed > 0 || disabled > 0
              ? `${failed} failed, ${disabled} disabled.`
              : "No push devices are registered for this account.",
        });
      }
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setTestBusy(false);
    }
  };

  const lastBackup = backupRuns.length > 0 ? backupRuns[0]?.createdAt ?? null : null;

  const themeOptions: Array<{
    id: ThemePreference;
    label: string;
    icon: ReactNode;
  }> = [
    { id: "light", label: "Paper", icon: <Sun className="h-4 w-4" /> },
    { id: "dark", label: "Lamp", icon: <Moon className="h-4 w-4" /> },
    { id: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={<span className="label-caps">Morrow · v0.3</span>}
        title="Settings"
        description="Account, time, assistant, delivery, and the quiet parts."
      />

      <div className="mt-6 grid gap-7 md:grid-cols-[190px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="md:sticky md:top-6 md:self-start">
          <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
            {visibleSections.map((item) => {
              const active = section === item.id;
              return (
                <li key={item.id} className="shrink-0 md:w-full">
                  <button
                    type="button"
                    onClick={() => goToSection(item.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 whitespace-nowrap rounded-md px-3 text-13 transition-colors",
                      active
                        ? "bg-accent-soft font-semibold text-accent"
                        : "text-muted hover:bg-selection hover:text-ink",
                    )}
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {!isOwner && OWNER_ONLY_SECTIONS.has(section) ? (
            <OwnerOnlyNotice
              title={
                section === "ai"
                  ? "Assistant"
                  : section === "backup"
                    ? "Backup"
                    : "Timezone"
              }
            />
          ) : null}

          {section === "account" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Account</h2>
                <p className="mt-1 text-13 text-muted">
                  {isOwner
                    ? "Your account. Add more people below; each account starts private."
                    : "Your account. The workspace owner manages additional people."}
                </p>
              </div>

              <Panel title="Signed in">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-accent-soft text-13 font-semibold text-accent">
                    {initials(userDisplayName(user))}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-13 font-medium text-ink">
                      {userDisplayName(user)}
                    </p>
                    <p className="truncate text-12 text-muted">
                      {user?.email || "Local account · no email"}
                    </p>
                  </div>
                  <StatusPill tone="success">Local</StatusPill>
                </div>
                <div className="mt-4">
                  <Row label="Username" value={user?.username || "owner"} />
                  <Row label="Session" value="7-day idle · 30-day absolute" />
                  <Row label="Workspace" value="Self-hosted · private accounts" />
                </div>
                <div className="mt-4">
                  <label htmlFor="account-timezone" className="field-label">
                    Account timezone
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      id="account-timezone"
                      className="select min-w-0 flex-1"
                      value={accountTimezone}
                      onChange={(event) =>
                        setAccountTimezone(event.target.value)
                      }
                    >
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() =>
                        updateMyTimezone.mutate(accountTimezone)
                      }
                      disabled={
                        updateMyTimezone.isPending ||
                        accountTimezone === (user?.timezone || detected)
                      }
                      aria-busy={updateMyTimezone.isPending}
                    >
                      {updateMyTimezone.isPending ? "Saving…" : "Save timezone"}
                    </button>
                  </div>
                  <p className="mt-2 text-12 leading-relaxed text-muted">
                    Your reminders, recurrence fallback and shared-list quiet
                    hours are resolved in this zone. {localTimeFor(accountTimezone)} now.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-danger mt-4"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </Panel>

              <PasswordPanel />

              <SessionsPanel />

              {isOwner ? <PeoplePanel /> : null}
            </div>
          ) : null}

          {isOwner && section === "timezone" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Timezone</h2>
                <p className="mt-1 text-13 text-muted">
                  Floating local times are resolved here. Past occurrences keep
                  their original keys.
                </p>
              </div>
              <Panel
                title="Workspace default timezone"
                description="Seeds new accounts and the owner-only agent fallback. Each person's Account timezone controls their own reminders."
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="settings-timezone" className="field-label">
                      Timezone
                    </label>
                    <select
                      id="settings-timezone"
                      className="select"
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                    >
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void saveTimezone()}
                    disabled={
                      updateSettings.isPending || timezone === settings.timezone
                    }
                    aria-busy={updateSettings.isPending}
                  >
                    {updateSettings.isPending ? "Saving…" : "Save timezone"}
                  </button>
                </div>
                <div className="mt-4 rounded-md border border-hairline bg-canvas px-3 py-2.5">
                  <p className="text-12 text-muted">Local time now</p>
                  <p className="mono mt-0.5 text-15 text-ink">
                    {localTimeFor(timezone)}
                  </p>
                </div>
                <p className="mt-3 text-12 leading-relaxed text-muted">
                  Server timestamps stay UTC. All-day tasks keep a local date and
                  never cross a UTC midnight.
                </p>
              </Panel>
            </div>
          ) : null}

          {isOwner && section === "ai" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Assistant</h2>
                <p className="mt-1 text-13 text-muted">
                  Optional. The deterministic core works with AI switched off.
                </p>
              </div>
              <Panel
                title="AI assistance"
                description="The assistant can propose changes; you always approve bulk edits and deletes. It only gets the narrow reminders_* tools."
              >
                <div className="mb-3">
                  <label htmlFor="assistant-step-up" className="field-label">
                    Morrow password (for assistant changes)
                  </label>
                  <input
                    id="assistant-step-up"
                    type="password"
                    className="input"
                    value={assistantPassword}
                    onChange={(event) =>
                      setAssistantPassword(event.target.value)
                    }
                    autoComplete="current-password"
                    placeholder="Your Morrow password"
                  />
                  <p className="field-help">
                    Enabling the assistant or changing its model needs a fresh
                    step-up confirmation.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border border-hairline bg-canvas px-3 py-3">
                  <div>
                    <p className="text-13 font-medium text-ink">Enable assistant</p>
                    <p className="mt-0.5 text-12 text-muted">
                      The sidecar is optional. Turning this off never affects
                      tasks, reminders, push, or backups.
                    </p>
                  </div>
                  <Switch.Root
                    checked={Boolean(assistantStatus?.enabled)}
                    disabled={
                      assistantSettings.isPending ||
                      !assistantStatus ||
                      assistantStatus.status === "not_configured"
                    }
                    onCheckedChange={(checked) =>
                      void saveAssistantSettings({ aiEnabled: checked })
                    }
                    aria-label="Enable assistant"
                    className="relative h-6 w-10 shrink-0 rounded-full bg-hairline-strong data-[state=checked]:bg-accent disabled:opacity-60"
                  >
                    <Switch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-canvas transition-transform data-[state=checked]:translate-x-[18px]" />
                  </Switch.Root>
                </div>

                <div className="mt-3">
                  <Row
                    label="Status"
                    value={statusLabel(assistantStatus)}
                    status={
                      <StatusPill
                        tone={
                          assistantStatus?.connected
                            ? "success"
                            : assistantStatus?.status === "model_missing" ||
                                assistantStatus?.status === "model_not_tool_capable"
                              ? "warning"
                              : "muted"
                        }
                      >
                        {assistantStatus?.status ?? "checking"}
                      </StatusPill>
                    }
                  />
                  <Row
                    label="Model"
                    value={assistantStatus?.model || "No model selected"}
                  />
                  <Row
                    label="Fallback"
                    value={assistantStatus?.fallbackModel || "Not set"}
                  />
                  <Row
                    label="OpenCode"
                    value={
                      assistantStatus?.version
                        ? `${assistantStatus.version} · pinned ${assistantStatus.pinnedVersion ?? "2.2.5"}`
                        : "Not connected"
                    }
                  />
                  <Row label="Policy" value="Propose bulk changes · no delete tool" />
                </div>

                {assistantStatus?.message ? (
                  <p className="mt-3 rounded-md border border-hairline bg-canvas px-3 py-2 text-12 leading-relaxed text-muted">
                    {assistantStatus.message}
                  </p>
                ) : null}

                <div className="mt-4">
                  <label htmlFor="ai-model" className="field-label">
                    Chat model
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <select
                      id="ai-model"
                      className="select min-w-0 flex-1"
                      value={aiModel}
                      onChange={(event) => setAiModel(event.target.value)}
                      disabled={
                        assistantSettings.isPending ||
                        !assistantStatus?.enabled ||
                        assistantModelsQuery.isPending
                      }
                    >
                      <option value="">Use the sidecar default</option>
                      {(assistantModelsQuery.data?.models ?? [])
                        .filter((model) => model.tools)
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {model.providerID}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        void saveAssistantSettings({ model: aiModel || null })
                      }
                      disabled={
                        assistantSettings.isPending ||
                        !assistantStatus?.enabled ||
                        aiModel === (assistantStatus?.model ?? "")
                      }
                    >
                      {assistantSettings.isPending ? "Saving…" : "Save model"}
                    </button>
                  </div>
                  {(() => {
                    const models = assistantModelsQuery.data?.models ?? [];
                    const currentId = aiModel || assistantStatus?.model || "";
                    const selected = models.find(
                      (model) => model.id === currentId,
                    );
                    const vision =
                      selected?.vision ??
                      (Array.isArray(selected?.input) &&
                        selected.input.includes("image")) ??
                      assistantStatus?.vision ??
                      false;
                    if (!currentId || !selected) return null;
                    return (
                      <p className="mt-2 text-12 leading-relaxed text-muted">
                        {vision ? "Reads images" : "Text only"} · attachments
                        need image input.
                      </p>
                    );
                  })()}
                  <p className="field-help">
                    Only tool-capable models are listed. The app validates the
                    selection against OpenCode’s <code>/api/model</code> before
                    saving. Providers added below refresh this list
                    automatically — or configure one with{" "}
                    <code className="mono text-12">
                      docker compose exec -it opencode opencode auth login
                    </code>
                    , then reload this page.
                  </p>
                  {!assistantModelsQuery.isPending &&
                  assistantStatus?.enabled &&
                  (assistantModelsQuery.data?.models ?? []).filter(
                    (model) => model.tools,
                  ).length === 0 ? (
                    <p className="mt-2 text-12 leading-relaxed text-warning">
                      No tool-capable models are connected. The assistant stays
                      off; remind me later.
                    </p>
                  ) : null}
                </div>

                <div className="mt-4">
                  <label htmlFor="ai-fallback-model" className="field-label">
                    Fallback model
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <select
                      id="ai-fallback-model"
                      className="select min-w-0 flex-1"
                      value={aiFallbackModel}
                      onChange={(event) =>
                        setAiFallbackModel(event.target.value)
                      }
                      disabled={
                        assistantSettings.isPending ||
                        !assistantStatus?.enabled ||
                        assistantModelsQuery.isPending
                      }
                    >
                      <option value="">No fallback</option>
                      {(assistantModelsQuery.data?.models ?? [])
                        .filter(
                          (model) =>
                            model.tools && model.id !== (aiModel || assistantStatus?.model),
                        )
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {model.providerID}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        void saveAssistantSettings({
                          fallbackModel: aiFallbackModel || null,
                        })
                      }
                      disabled={
                        assistantSettings.isPending ||
                        !assistantStatus?.enabled ||
                        aiFallbackModel ===
                          (assistantStatus?.fallbackModel ?? "")
                      }
                    >
                      {assistantSettings.isPending ? "Saving…" : "Save fallback"}
                    </button>
                  </div>
                  <p className="field-help">
                    A recovery model for provider quota or outage. Morrow never
                    switches silently; use the button below, then start a new
                    conversation so the fresh OpenCode session uses it.
                  </p>
                  {aiFallbackModel &&
                  aiFallbackModel !== (assistantStatus?.model ?? "") ? (
                    <button
                      type="button"
                      className="btn btn-secondary mt-2"
                      onClick={() =>
                        void saveAssistantSettings({ model: aiFallbackModel })
                      }
                      disabled={assistantSettings.isPending}
                    >
                      Use fallback now
                    </button>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openAssistant()}
                  >
                    <Bot className="h-4 w-4" aria-hidden="true" />
                    Open assistant
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void assistantStatusQuery.refetch()}
                  >
                    Check connection
                  </button>
                </div>
              </Panel>
              <ProviderSection />
            </div>
          ) : null}

          {section === "devices" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Devices &amp; notifications</h2>
                <p className="mt-1 text-13 text-muted">
                  Reminders stay inside the app until push is connected. No fake
                  “all set.”
                </p>
              </div>

              {push.ios && !push.standalone ? (
                <div
                  className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-12 leading-relaxed text-warning"
                  role="note"
                >
                  iPhone/iPad detected in a browser tab. iOS push needs iOS 16.4+
                  and an installed Home Screen app — install first, then enable
                  notifications.{" "}
                  <Link
                    to="/install"
                    className="font-semibold underline underline-offset-2"
                  >
                    Install help
                  </Link>
                </div>
              ) : null}

              <Panel
                title="This device"
                description="Push subscription and install state are checked at launch. A granted permission with a missing subscription is repaired automatically."
              >
                <div aria-live="polite">
                  <Row
                    label="Notifications"
                    value={
                      push.permission === "unsupported"
                        ? "Unsupported browser"
                        : push.permission === "default"
                          ? "Not asked yet"
                          : push.permission === "granted"
                            ? "Allowed"
                            : "Blocked"
                    }
                    status={
                      <StatusPill tone={statusToneForPermission(push.permission)}>
                        {push.permission}
                      </StatusPill>
                    }
                  />
                  <Row
                    label="Push subscription"
                    value={push.subscribed ? "Registered" : "Not registered"}
                    status={
                      <StatusPill tone={push.subscribed ? "success" : "warning"}>
                        {push.subscribed ? "subscribed" : "missing"}
                      </StatusPill>
                    }
                  />
                  <Row
                    label="Installed"
                    value={push.standalone ? "Standalone window" : "Browser tab"}
                    status={
                      <StatusPill tone={push.standalone ? "success" : "muted"}>
                        {push.standalone ? "installed" : "browser"}
                      </StatusPill>
                    }
                  />
                  <Row
                    label="iOS"
                    value={
                      push.ios
                        ? "Push requires a Home Screen install (16.4+)"
                        : "Not an iOS device"
                    }
                  />
                  <Row
                    label="Last sync"
                    value={online ? "Online" : "Offline"}
                    status={
                      <StatusPill tone={online ? "success" : "warning"}>
                        {online ? "online" : "offline"}
                      </StatusPill>
                    }
                  />
                </div>

                {push.error ? (
                  <p role="alert" className="mt-3 text-12 leading-relaxed text-danger">
                    {push.error}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  {push.permission === "default" && !push.subscribed ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void enableNotifications()}
                      disabled={!push.supported || push.busy}
                      aria-busy={push.busy}
                    >
                      <Bell className="h-4 w-4" aria-hidden="true" />
                      {push.busy ? "Enabling…" : "Enable notifications"}
                    </button>
                  ) : null}
                  {push.permission === "granted" && !push.subscribed ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void finishRegistration()}
                      disabled={push.busy}
                      aria-busy={push.busy}
                    >
                      <Bell className="h-4 w-4" aria-hidden="true" />
                      {push.busy ? "Registering…" : "Finish device registration"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void sendTestPing()}
                    disabled={!push.subscribed || push.busy || testBusy}
                    aria-busy={testBusy}
                    title={
                      push.subscribed
                        ? "Send an immediate TTL-0 test push"
                        : "Register this device first"
                    }
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {testBusy ? "Sending…" : "Send test ping"}
                  </button>
                  {push.subscribed ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void removeDevice()}
                      disabled={push.busy}
                    >
                      Remove this device
                    </button>
                  ) : null}
                </div>
                {push.permission === "denied" ? (
                  <div
                    className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-12 leading-relaxed text-danger"
                    role="note"
                  >
                    <p className="font-semibold">
                      Push is off. Reminders will wait inside the app.
                    </p>
                    <p className="mt-1">
                      Re-enable notifications in your browser’s site settings
                      (address bar → site settings → Notifications → Allow), then
                      return here and register the device. Morrow will not ask
                      again on its own.
                    </p>
                  </div>
                ) : push.permission === "granted" && !push.subscribed ? (
                  <p className="mt-3 text-12 leading-relaxed text-muted">
                    Permission is granted but no subscription was found (iOS never
                    reports replacements). Registration repairs itself at launch;
                    the button above retries it now.
                  </p>
                ) : !push.subscribed ? (
                  <p className="mt-3 text-12 leading-relaxed text-muted">
                    Notifications are asked for only when you tap the button —
                    never at launch, never again after a denial.
                  </p>
                ) : (
                  <p className="mt-3 text-12 leading-relaxed text-muted">
                    Registered. The test ping sends immediately (TTL 0) and the
                    result is reported honestly. Per-task state lives in the
                    delivery ledger on each task.
                  </p>
                )}
                {isLocalhost ? (
                  <p className="mt-3 rounded-md border border-hairline bg-canvas px-3 py-2.5 text-12 leading-relaxed text-muted" role="note">
                    You are on localhost. Desktop Chrome/Firefox push works
                    here, but Apple&apos;s push service rejects localhost and
                    non-HTTPS origins: iPhone delivery needs this instance
                    served over HTTPS with a real VAPID subject (a{" "}
                    <code className="mono">mailto:</code> or{" "}
                    <code className="mono">https:</code> contact). Until then,
                    iOS reminders wait inside the app.
                  </p>
                ) : null}
              </Panel>

              <Panel title="Install" description="Installable on desktop and mobile.">
                <InstallHelp />
              </Panel>

              {isOwner ? (
                <>
                  <QuietHoursPanel />

                  <DigestPanel />

                  <NtfyPanel />
                </>
              ) : (
                <Panel
                  title="Workspace delivery settings"
                  description="Quiet hours, briefs, and ntfy are shared by everyone on this server."
                >
                  <p className="text-13 leading-relaxed text-muted">
                    The workspace owner manages these global delivery channels.
                    Your own push devices above still work normally.
                  </p>
                </Panel>
              )}
            </div>
          ) : null}

          {section === "tags" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Tags</h2>
                <p className="mt-1 text-13 text-muted">
                  Group reminders across lists with reusable labels.
                </p>
              </div>
              <TagsSettingsPanel />
            </div>
          ) : null}

          {section === "integrations" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Integrations</h2>
                <p className="mt-1 text-13 text-muted">
                  Capture reminders from Shortcuts, Siri, voice, and scripts.
                </p>
              </div>
              <CaptureTokensPanel />

              <CalendarIntegrationPanel />
            </div>
          ) : null}

          {isOwner && section === "backup" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">Backup</h2>
                <p className="mt-1 text-13 text-muted">
                  Portable JSON, written nightly and on demand.
                </p>
              </div>
              <Panel
                title="Export"
                description="Download a versioned JSON snapshot. Secrets and session tokens are excluded."
              >
                <div>
                  <Row
                    label="Last backup"
                    value={
                      backupRunsPending
                        ? "Checking…"
                        : lastBackup
                          ? new Date(lastBackup).toLocaleString()
                          : "No backup recorded yet"
                    }
                    status={
                      <StatusPill tone={lastBackup ? "success" : "warning"}>
                        {backupRunsPending
                          ? "checking"
                          : lastBackup
                            ? `recorded${backupRuns.length > 1 ? ` · ${backupRuns.length}` : ""}`
                            : "none yet"}
                      </StatusPill>
                    }
                  />
                  <Row label="Retention" value="14 daily · 8 weekly · 6 monthly" />
                  <Row label="Format" value="morrow.backup · schema 3 · SHA-256 / age" />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void downloadBackup()}
                  >
                    <CloudDownload className="h-4 w-4" aria-hidden="true" />
                    Download JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void runSnapshotNow()}
                    disabled={snapshotBusy}
                    aria-busy={snapshotBusy}
                  >
                    <Database className="h-4 w-4" aria-hidden="true" />
                    {snapshotBusy ? "Saving…" : "Snapshot now"}
                  </button>
                </div>
                <div className="mt-3">
                  <label htmlFor="snapshot-password" className="field-label">
                    Password (for Snapshot now)
                  </label>
                  <input
                    id="snapshot-password"
                    type="password"
                    className="input"
                    value={snapshotPassword}
                    onChange={(event) => setSnapshotPassword(event.target.value)}
                    autoComplete="current-password"
                    placeholder="Your Morrow password"
                  />
                  <p className="field-help">
                    Snapshots need a fresh confirmation. Enter your password once, then Snapshot now.
                    Downloads use the same confirmation.
                  </p>
                </div>
                <p className="mt-3 text-12 leading-relaxed text-muted">
                  Restore replaces current tasks. Morrow keeps a copy first and
                  requires a typed confirmation.
                </p>
              </Panel>

              <BackupRestorePanel />

              <Panel
                title="Run your own copy"
                description="The SQLite file lives on your volume; JSON is the portable copy."
              >
                <p className="text-13 leading-relaxed text-muted">
                  Keep the backup directory on a different disk or machine. A
                  backup that lives beside the database is not a backup.
                </p>
              </Panel>
            </div>
          ) : null}

          {section === "about" ? (
            <div className="space-y-4">
              <div>
                <h2 className="serif text-22">About</h2>
                <p className="mt-1 text-13 text-muted">
                  A small, self-hosted reminder app. No feed, no algorithm.
                </p>
              </div>

              <Panel title="Appearance" description="Theme follows the system unless you choose otherwise.">
                <div className="grid grid-cols-3 gap-2">
                  {themeOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={preference === option.id}
                      onClick={() => setPreference(option.id)}
                      className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-md border border-hairline bg-canvas text-12 text-muted hover:border-hairline-strong aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent"
                    >
                      {option.icon}
                      {option.label}
                    </button>
                  ))}
                </div>
              </Panel>

              <Panel title="This build">
                <UpdateAvailable />
                <div>
                  <Row label="Version" value="0.3.0" status={<StatusPill tone="muted">Beta</StatusPill>} />
                  <Row label="Mode" value={push.standalone ? "Installed PWA" : "Browser"} />
                  <Row
                    label="Service worker"
                    value={
                      "serviceWorker" in navigator
                        ? "Supported"
                        : "Unsupported in this browser"
                    }
                  />
                  <Row label="Deployment" value="Self-hosted · private accounts" />
                  <Row label="Data" value="SQLite on your volume · JSON backups" />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link to="/install" className="btn btn-secondary">
                    <Smartphone className="h-4 w-4" aria-hidden="true" />
                    Install help
                  </Link>
                  <Link to="/trash" className="btn btn-secondary">
                    Recently deleted
                  </Link>
                </div>
              </Panel>

              <div className="flex items-start gap-3 rounded-md border border-hairline bg-surface p-4 text-12 leading-relaxed text-muted">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                <p>
                  Session cookies are HttpOnly and SameSite=Strict. Local caches
                  and the offline outbox are purged on sign-out. Reminder delivery
                  is at-least-once, never “exactly once.”
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
