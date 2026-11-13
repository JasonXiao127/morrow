import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  Copy,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Tag as TagIcon,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { authApi, ntfyApi, userApi, type Tag } from "@/api";
import { apiErrorMessage } from "@/api";
import { useAppData, useUpdateSettings } from "@/lib/queries";
import {
  useBackupImport,
  useCaptureTokenMutations,
  useCaptureTokens,
  useCreateTag,
  useDeleteTag,
  useSessionMutations,
  useSessions,
  useTags,
  useUpdateTag,
} from "@/lib/product";

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
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

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function PasswordPanel() {
  const { changePassword } = useSessionMutations();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <Panel
      title="Password"
      description="Changing your password signs out every other session."
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="oc-field grid gap-1.5 sm:col-span-2">
          <span className="field-label">Current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="field-label">New password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="field-label">Confirm new password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-13 text-danger sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end sm:col-span-2">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={changePassword.isPending || !currentPassword || !newPassword}
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {changePassword.isPending ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function SessionsPanel() {
  const query = useSessions();
  const { revoke } = useSessionMutations();
  const [password, setPassword] = useState("");
  const revokeOther = async (id: string): Promise<void> => {
    if (!password) {
      toast.error("Enter your Morrow password first.", {
        description: "Revoking another device needs a fresh step-up.",
      });
      return;
    }
    try {
      await authApi.stepUp(password);
      revoke.mutate(id);
    } catch {
      toast.error("That password didn't match.");
    }
  };
  return (
    <Panel
      title="Signed-in sessions"
      description="Revoke a device you no longer use. Revoking another device needs a fresh password step-up."
    >
      <div className="mb-3">
        <label htmlFor="sessions-step-up" className="field-label">
          Password (step-up)
        </label>
        <input
          id="sessions-step-up"
          type="password"
          className="input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          placeholder="Your Morrow password"
        />
      </div>
      <div className="space-y-2">
        {(query.data ?? []).map((session) => (
          <div
            key={session.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-canvas px-3 py-2"
          >
            <Smartphone className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-13 text-ink-soft">
                {session.current ? "This device" : session.userAgent || "Unknown device"}
              </p>
              <p className="mono truncate text-11 text-faint">
                Last seen {formatWhen(session.lastSeenAt)} · expires{" "}
                {formatWhen(session.expiresAt)}
              </p>
            </div>
            {session.current ? (
              <span className="rounded-full border border-success/30 bg-success-soft px-2 py-0.5 text-11 text-success">
                current
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost min-h-9 px-2 text-12 text-danger"
                onClick={() => void revokeOther(session.id)}
                disabled={revoke.isPending}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        {query.data?.length === 0 ? (
          <p className="text-13 text-muted">No active sessions.</p>
        ) : null}
      </div>
    </Panel>
  );
}

export function PeoplePanel() {
  const { settings } = useAppData();
  const queryClient = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => userApi.list(),
    staleTime: 15_000,
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(username.trim())) {
      setError("Username must be 2–64 letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (!stepUpPassword) {
      setError("Confirm your own password to add an account.");
      return;
    }
    setBusy(true);
    try {
      await authApi.stepUp(stepUpPassword);
      await userApi.create({
        username: username.trim().toLowerCase(),
        password,
        timezone: settings.timezone ?? "UTC",
      });
      setUsername("");
      setPassword("");
      setStepUpPassword("");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Account added.", {
        description: "It has its own private lists and tasks.",
      });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="People"
      description="Additional accounts have private lists, tasks, reminders, and push devices. Share an individual list from its menu."
    >
      <ul className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-canvas">
        {(users.data ?? []).map((user) => (
          <li key={user.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-surface text-11 font-semibold text-accent">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-13 text-ink-soft">{user.username}</p>
              <p className="text-11 text-faint">{user.timezone}</p>
            </div>
            {user.current ? (
              <span className="rounded-full border border-success/30 bg-success-soft px-2 py-0.5 text-11 text-success">
                you
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="grid gap-1.5">
          <span className="field-label">New username</span>
          <input
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="field-label">New password (≥12 chars)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 sm:col-span-2">
          <span className="field-label">Your password (step-up)</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={stepUpPassword}
            onChange={(event) => setStepUpPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-13 text-danger sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end sm:col-span-2">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !username.trim() || !password || !stepUpPassword}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {busy ? "Adding…" : "Add account"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function QuietHoursPanel() {
  const { settings } = useAppData();
  const updateSettings = useUpdateSettings();
  const quiet = (settings.quietHours ?? {}) as {
    enabled?: boolean;
    start?: string;
    end?: string;
  };
  const [enabled, setEnabled] = useState(Boolean(quiet.enabled));
  const [start, setStart] = useState((quiet.start ?? "22:00").slice(0, 5));
  const [end, setEnd] = useState((quiet.end ?? "07:00").slice(0, 5));

  useEffect(() => {
    setEnabled(Boolean(quiet.enabled));
    setStart((quiet.start ?? "22:00").slice(0, 5));
    setEnd((quiet.end ?? "07:00").slice(0, 5));
  }, [quiet.enabled, quiet.start, quiet.end]);

  const save = () => {
    updateSettings.mutate({
      quietHours: {
        enabled,
        start: start.length === 5 ? `${start}:00` : start,
        end: end.length === 5 ? `${end}:00` : end,
      },
    });
  };

  return (
    <Panel
      title="Quiet hours"
      description="Non-urgent reminders wait until quiet hours end. Urgent tasks (priority High or Urgent) still fire."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-13 text-ink-soft">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable quiet hours
        </label>
        <label className="grid gap-1">
          <span className="field-label">From</span>
          <input
            type="time"
            className="input"
            value={start}
            disabled={!enabled}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="field-label">Until</span>
          <input
            type="time"
            className="input"
            value={end}
            disabled={!enabled}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={updateSettings.isPending}
        >
          Save quiet hours
        </button>
      </div>
    </Panel>
  );
}

export function DigestPanel() {
  const { settings } = useAppData();
  const updateSettings = useUpdateSettings();
  const digest = (settings.digest ?? {}) as {
    morning?: { enabled?: boolean; time?: string };
    weekly?: { enabled?: boolean; day?: number; time?: string };
  };
  const [morning, setMorning] = useState(Boolean(digest.morning?.enabled));
  const [morningTime, setMorningTime] = useState(
    (digest.morning?.time ?? "08:00").slice(0, 5),
  );
  const [weekly, setWeekly] = useState(Boolean(digest.weekly?.enabled));
  const [weeklyDay, setWeeklyDay] = useState(String(digest.weekly?.day ?? 1));
  const [weeklyTime, setWeeklyTime] = useState(
    (digest.weekly?.time ?? "08:00").slice(0, 5),
  );

  const save = () => {
    updateSettings.mutate({
      digest: {
        morning: { enabled: morning, time: morningTime },
        weekly: {
          enabled: weekly,
          day: Number.parseInt(weeklyDay, 10),
          time: weeklyTime,
        },
      },
    });
  };

  return (
    <Panel
      title="Briefs"
      description="A morning overview and a weekly review, delivered through your enabled channels."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-13 text-ink-soft">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={morning}
              onChange={(event) => setMorning(event.target.checked)}
            />
            Morning brief
          </label>
          <input
            type="time"
            className="input"
            value={morningTime}
            disabled={!morning}
            onChange={(event) => setMorningTime(event.target.value)}
            aria-label="Morning brief time"
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-13 text-ink-soft">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={weekly}
              onChange={(event) => setWeekly(event.target.checked)}
            />
            Weekly review
          </label>
          <select
            className="select"
            value={weeklyDay}
            disabled={!weekly}
            onChange={(event) => setWeeklyDay(event.target.value)}
            aria-label="Weekly review day"
          >
            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
              (day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ),
            )}
          </select>
          <input
            type="time"
            className="input"
            value={weeklyTime}
            disabled={!weekly}
            onChange={(event) => setWeeklyTime(event.target.value)}
            aria-label="Weekly review time"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={updateSettings.isPending}
          >
            Save briefs
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function NtfyPanel() {
  const { settings } = useAppData();
  const updateSettings = useUpdateSettings();
  const ntfy = (settings.ntfy ?? {}) as {
    enabled?: boolean;
    url?: string;
    topic?: string;
    priority?: number;
  };
  const [enabled, setEnabled] = useState(Boolean(ntfy.enabled));
  const [url, setUrl] = useState(ntfy.url ?? "https://ntfy.sh");
  const [topic, setTopic] = useState(ntfy.topic ?? "");
  const [priority, setPriority] = useState(String(ntfy.priority ?? 3));
  const [testing, setTesting] = useState(false);

  const save = () => {
    updateSettings.mutate({
      ntfy: {
        enabled,
        url: url.trim(),
        topic: topic.trim(),
        priority: Number.parseInt(priority, 10),
      },
    });
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await ntfyApi.test();
      if (result.ok) toast.success("ntfy test sent.");
      else toast.error(result.error ?? "ntfy test failed.");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel
      title="ntfy"
      description="Send reminders and briefs to a self-hosted or hosted ntfy topic. The optional bearer token comes from NTFY_TOKEN or SECRETS_DIR/ntfy_token."
    >
      <div className="space-y-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-13 text-ink-soft">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable ntfy channel
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="field-label">Server URL</span>
            <input
              className="input mono"
              value={url}
              disabled={!enabled}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://ntfy.sh"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="field-label">Topic</span>
            <input
              className="input mono"
              value={topic}
              disabled={!enabled}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="morrow-private-topic"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="field-label">Priority</span>
            <select
              className="select"
              value={priority}
              disabled={!enabled}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value="2">Low</option>
              <option value="3">Default</option>
              <option value="4">High</option>
              <option value="5">Urgent</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void test()}
            disabled={!enabled || !topic.trim() || testing}
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
            {testing ? "Sending…" : "Send test"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={updateSettings.isPending}
          >
            Save ntfy
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function TagsSettingsPanel() {
  const tags = useTags();
  const create = useCreateTag();
  const update = useUpdateTag();
  const remove = useDeleteTag();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const submit = async () => {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ name: name.trim() });
      setName("");
    } catch {
      // Toast is handled by the mutation.
    }
  };

  return (
    <Panel title="Tags" description="Labels shared across lists. Task details can add or remove them.">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="input flex-1"
          value={name}
          maxLength={80}
          placeholder="New tag name"
          onChange={(event) => setName(event.target.value)}
        />
        <button className="btn btn-secondary" type="submit" disabled={!name.trim() || create.isPending}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add
        </button>
      </form>
      <ul className="mt-3 divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-canvas">
        {tags.map((tag: Tag) => (
          <li key={tag.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
            <TagIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            {editingId === tag.id ? (
              <input
                className="input min-h-9 flex-1"
                value={editingName}
                onChange={(event) => setEditingName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (editingName.trim()) {
                      update.mutate(
                        { tag, patch: { name: editingName.trim() } },
                        {
                          onSuccess: () => {
                            setEditingId(null);
                            setEditingName("");
                          },
                        },
                      );
                    }
                  }
                }}
                autoFocus
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-13 text-ink-soft">
                {tag.name}
                <span className="ml-2 text-11 text-faint">{tag.openCount ?? 0}</span>
              </span>
            )}
            {editingId === tag.id ? (
              <button
                type="button"
                className="icon-btn h-9 w-9 text-success"
                aria-label={`Save ${tag.name}`}
                onClick={() =>
                  editingName.trim() &&
                  update.mutate(
                    { tag, patch: { name: editingName.trim() } },
                    {
                      onSuccess: () => {
                        setEditingId(null);
                        setEditingName("");
                      },
                    },
                  )
                }
              >
                <Check className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost min-h-9 px-2 text-12"
                onClick={() => {
                  setEditingId(tag.id);
                  setEditingName(tag.name);
                }}
              >
                Rename
              </button>
            )}
            <button
              type="button"
              className="icon-btn h-9 w-9 text-faint hover:text-danger"
              aria-label={`Delete ${tag.name}`}
              onClick={() => remove.mutate(tag)}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
        {tags.length === 0 ? (
          <li className="px-3 py-3 text-13 text-muted">No tags yet.</li>
        ) : null}
      </ul>
    </Panel>
  );
}

export function CaptureTokensPanel() {
  const query = useCaptureTokens();
  const { create, revoke } = useCaptureTokenMutations();
  const [name, setName] = useState("Shortcuts");
  const [kind, setKind] = useState<"capture" | "caldav">("capture");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    try {
      const token = await create.mutateAsync({ name: name.trim(), kind });
      setFreshToken(token.token ?? null);
    } catch {
      // handled
    }
  };

  return (
    <Panel
      title="Capture & CalDAV tokens"
      description="Capture tokens can only create reminders (Shortcuts, Siri, email). CalDAV tokens can only read/write the calendar. They are not interchangeable."
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="input min-w-[12rem] flex-1"
          value={name}
          maxLength={80}
          placeholder="Token name"
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="select w-auto"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === "caldav" ? "caldav" : "capture")
          }
          aria-label="Token purpose"
        >
          <option value="capture">Capture / email</option>
          <option value="caldav">CalDAV</option>
        </select>
        <button className="btn btn-secondary" type="submit" disabled={!name.trim() || create.isPending}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create token
        </button>
      </form>

      {freshToken ? (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning-soft p-3">
          <p className="text-12 font-semibold text-warning">
            Copy this token now. It will not be shown again.
          </p>
          <div className="mt-2 flex gap-2">
            <input className="input mono flex-1 text-12" readOnly value={freshToken} />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(freshToken);
                toast.success("Token copied.");
              }}
            >
              <Copy className="h-4 w-4" />
              Copy
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-md border border-hairline bg-canvas p-3 text-12 leading-relaxed text-muted">
        <p className="font-semibold text-ink-soft">Shortcuts / Siri</p>
        <p className="mt-1">
          Use <span className="mono">Get Contents of URL</span> with method{" "}
          <span className="mono">POST</span> to{" "}
          <span className="mono">{typeof window !== "undefined" ? window.location.origin : ""}/api/capture/quick</span>.
          Add header <span className="mono">Authorization: Bearer &lt;token&gt;</span> and
          JSON body <span className="mono">{`{"text":"call Sam tomorrow at 9 #p2 @Work"}`}</span>.
        </p>
      </div>

      <ul className="mt-3 divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-canvas">
        {(query.data ?? []).map((token) => (
          <li key={token.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-13 text-ink-soft">
                {token.name}
                <span className="ml-2 rounded-full border border-hairline bg-surface px-1.5 py-0.5 text-11 uppercase tracking-wide text-muted">
                  {token.kind === "caldav" ? "CalDAV" : "Capture"}
                </span>
              </p>
              <p className="mono text-11 text-faint">
                last used {formatWhen(token.lastUsedAt)}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost min-h-9 px-2 text-12 text-danger"
              onClick={() => revoke.mutate(token.id)}
              disabled={revoke.isPending}
            >
              Revoke
            </button>
          </li>
        ))}
        {(query.data ?? []).length === 0 ? (
          <li className="px-3 py-3 text-13 text-muted">No tokens yet.</li>
        ) : null}
      </ul>
    </Panel>
  );
}

export function CalendarIntegrationPanel() {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://morrow.example.com";
  return (
    <Panel
      title="Calendar (ICS / CalDAV)"
      description="Subscribe from Apple Calendar, Thunderbird, DAVx5, or any CalDAV client. Calendar credentials are separate from capture tokens — create a CalDAV token above."
    >
      <div className="space-y-3 text-12 leading-relaxed text-muted">
        <div>
          <p className="font-semibold text-ink-soft">Read-only feed</p>
          <p className="mono mt-1 break-all rounded-md border border-hairline bg-canvas px-2.5 py-2 text-11">
            {origin}/api/calendar.ics?token=&lt;caldav-token&gt;
          </p>
        </div>
        <div>
          <p className="font-semibold text-ink-soft">CalDAV server</p>
          <p className="mono mt-1 break-all rounded-md border border-hairline bg-canvas px-2.5 py-2 text-11">
            {origin}/caldav/
          </p>
          <p className="mt-1">
            Username <span className="mono">owner</span>; password is a token
            created with purpose <span className="mono">CalDAV</span>. CalDAV
            clients read and write VTODO tasks, not VEVENT events; the feed
            above is the read-only event view. Deletes are soft-deletes and
            appear in Recently deleted. Use the per-list or Inbox collections:
            the legacy <span className="mono">/caldav/calendars/morrow/</span>{" "}
            alias is read-only. Recurrence overrides/EXDATE and read-only
            attachments are supported.
          </p>
        </div>
        <div>
          <p className="font-semibold text-ink-soft">Email ingestion</p>
          <p className="mt-1">
            Point an email-to-webhook service at{" "}
            <span className="mono">POST /api/inbound/email?token=&lt;capture-token&gt;</span>{" "}
            with JSON <span className="mono">{`{"subject":"…","text":"…"}`}</span>.
          </p>
        </div>
      </div>
    </Panel>
  );
}

export function BackupRestorePanel() {
  const importBackup = useBackupImport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [preview, setPreview] = useState<{
    counts: Record<string, number>;
    diff?: unknown;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requireFile = (): File | null => {
    if (!file) {
      setError("Choose a Morrow JSON backup first.");
      return null;
    }
    return file;
  };

  const previewRestore = async () => {
    const chosen = requireFile();
    if (!chosen) return;
    setError(null);
    if (!password) {
      setError("Enter your Morrow password to preview a restore.");
      return;
    }
    try {
      await authApi.stepUp(password);
      const result = await importBackup.mutateAsync({
        file: chosen,
        dryRun: true,
      });
      setPreview({ counts: result.counts, diff: result.diff });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const restore = async () => {
    const chosen = requireFile();
    if (!chosen) return;
    setError(null);
    if (confirm !== "RESTORE") {
      setError('Type "RESTORE" to confirm.');
      return;
    }
    if (!password) {
      setError("Enter your Morrow password to restore.");
      return;
    }
    try {
      await authApi.stepUp(password);
      await importBackup.mutateAsync({
        file: chosen,
        dryRun: false,
        confirm: "RESTORE",
      });
      window.location.assign("/login");
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <Panel
      title="Restore from backup"
      description="Accepts .json and age-encrypted .json.age. A restore replaces current data, writes a pre-restore snapshot, then signs out every session."
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,application/octet-stream,.json,.age,.json.age"
          className="sr-only"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null);
            setConfirm("");
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          Choose backup
        </button>
        <span className="min-w-0 truncate text-13 text-muted">
          {file ? file.name : "No file chosen"}
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="field-label">Morrow password</span>
          <input
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="field-label">Type RESTORE to confirm</span>
          <input
            className="input mono"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="RESTORE"
          />
        </label>
      </div>

      {preview ? (
        <div className="mt-3 rounded-md border border-hairline bg-canvas p-3 text-12 text-muted">
          <p className="font-semibold text-ink-soft">Preview</p>
          <p className="mt-1">
            {preview.counts.lists ?? 0} lists · {preview.counts.tasks ?? 0} tasks ·{" "}
            {preview.counts.taskCompletions ?? 0} completions ·{" "}
            {preview.counts.settings ?? 0} settings
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-13 text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void previewRestore()}
          disabled={importBackup.isPending || !file}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Preview restore
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void restore()}
          disabled={importBackup.isPending || !file || confirm !== "RESTORE"}
        >
          <Power className="h-4 w-4" aria-hidden="true" />
          Restore and sign out
        </button>
      </div>
    </Panel>
  );
}
