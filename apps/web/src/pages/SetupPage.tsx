import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiErrorMessage, isApiError } from "@/api";
import { setupStatusQueryOptions } from "@/lib/query";
import { prepareFreshSession } from "@/lib/session";
import { localTimeFor, timezoneList } from "@/lib/timezone";
import { AuthLayout } from "./AuthLayout";

export function SetupPage() {
  const navigate = useNavigate();
  const setupStatus = useQuery(setupStatusQueryOptions);
  // The route guard resolves this before rendering; true is the safe fallback
  // when the probe failed (the server still decides whether a token is needed).
  const tokenRequired = setupStatus.data?.tokenRequired ?? true;
  const zones = useMemo(timezoneList, []);
  // Token-mode operators can open /setup?token=… so they do not have to paste
  // the secret from a terminal.
  const prefilledToken = useMemo(() => {
    if (typeof window === "undefined") return "";
    return (
      new URLSearchParams(window.location.search).get("token")?.trim() ?? ""
    );
  }, []);
  const [setupToken, setSetupToken] = useState(prefilledToken);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadySetup, setAlreadySetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    setAlreadySetup(false);

    if (tokenRequired && !setupToken.trim()) {
      setError("Paste the setup token from the installer.");
      return;
    }
    if (password.length < 12) {
      setError("Use at least 12 characters for the password.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don’t match.");
      return;
    }

    setSubmitting(true);
    try {
      await api.setup({
        ...(tokenRequired ? { token: setupToken.trim() } : {}),
        password,
        timezone,
      });
      await prepareFreshSession();
      toast.success("Welcome to Morrow.");
      void navigate({ to: "/today", replace: true });
    } catch (submitError) {
      if (isApiError(submitError) && submitError.code === "csrf") {
        // Never blame the token for a deployment/origin problem.
        setError(apiErrorMessage(submitError));
      } else if (isApiError(submitError) && submitError.status === 409) {
        setAlreadySetup(true);
        setError("Morrow is already set up. Sign in instead.");
      } else if (
        isApiError(submitError) &&
        (submitError.code === "invalid_token" ||
          submitError.status === 401 ||
          submitError.status === 403)
      ) {
        setError(
          "That setup token doesn’t match. Use the token from your deployment.",
        );
      } else {
        setError(apiErrorMessage(submitError));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <div>
        <p className="label-caps">First run</p>
        <h1 className="serif mt-2 text-28 md:text-[2rem] md:leading-[2.25rem]">
          Make this place yours.
        </h1>
        <p className="mt-2 text-13 leading-relaxed text-muted">
          Create the first account for this instance. It becomes the workspace
          owner.
          {tokenRequired
            ? " You also need the one-time setup token from your deployment."
            : ""}
        </p>
      </div>

      {!tokenRequired ? (
        <div
          role="note"
          className="mt-5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-12 leading-relaxed text-warning"
        >
          Anyone who can reach this address before you finish can claim this
          instance. It is intended for a trusted LAN or VPN; complete setup now.
        </div>
      ) : null}

      <form
        className="mt-7 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {tokenRequired ? (
          <div>
            <label htmlFor="setup-token" className="field-label">
              Setup token
            </label>
            <input
              id="setup-token"
              className="input mono text-13"
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the one-time token"
              autoFocus={!prefilledToken}
            />
            <details className="mt-2 text-12 leading-relaxed text-muted">
              <summary className="cursor-pointer">Where do I find it?</summary>
              <div className="mt-2 space-y-2">
                <p>
                  This instance requires a token (<code className="mono">
                    SETUP_MODE=token
                  </code>
                  ). Docker: <code className="mono">SETUP_TOKEN</code> in{" "}
                  <code className="mono">.env</code>. Source checkout:{" "}
                  <code className="mono">data/secrets/setup_token</code>.
                </p>
                <code className="mono block overflow-x-auto rounded border border-hairline bg-surface px-2 py-1.5">
                  grep '^SETUP_TOKEN=' .env | cut -d= -f2-
                </code>
                <p>The server logs the setup URL at first boot.</p>
              </div>
            </details>
          </div>
        ) : null}

        <div>
          <label htmlFor="setup-password" className="field-label">
            Password
          </label>
          <div className="relative">
            <input
              id="setup-password"
              type={showPassword ? "text" : "password"}
              className="input pr-12"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="At least 12 characters"
              aria-describedby="setup-password-help"
              autoFocus={!tokenRequired || Boolean(prefilledToken)}
            />
            <button
              type="button"
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted hover:text-ink"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <p id="setup-password-help" className="field-help">
            Used with Argon2id. There is no password reset email.
          </p>
        </div>

        <div>
          <label htmlFor="setup-confirm" className="field-label">
            Confirm password
          </label>
          <input
            id="setup-confirm"
            type={showPassword ? "text" : "password"}
            className="input"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
          />
        </div>

        <div>
          <label htmlFor="setup-timezone" className="field-label">
            Timezone
          </label>
          <select
            id="setup-timezone"
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
          <p className="field-help">Now: {localTimeFor(timezone)}</p>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-13 text-danger"
          >
            {error}
            {alreadySetup ? (
              <>
                {" "}
                <Link to="/login" className="underline underline-offset-2">
                  Go to sign in
                </Link>
              </>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary w-full"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Setting up…
            </>
          ) : (
            "Create workspace"
          )}
        </button>
      </form>

      {setupStatus.data?.setupRequired === false ? (
        <p className="mt-5 text-center text-13 text-muted">
          Already set up?{" "}
          <Link
            to="/login"
            className="font-medium text-accent underline underline-offset-2"
          >
            Sign in
          </Link>
        </p>
      ) : null}
    </AuthLayout>
  );
}
