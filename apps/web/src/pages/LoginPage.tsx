import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiErrorMessage, isApiError } from "@/api";
import { setupStatusQueryOptions } from "@/lib/query";
import { prepareFreshSession } from "@/lib/session";
import { AuthLayout } from "./AuthLayout";

function nextPathFromLocation(): string {
  const candidate = new URLSearchParams(window.location.search).get("next");
  if (candidate && candidate.startsWith("/") && !candidate.startsWith("//")) {
    return candidate;
  }
  return "/today";
}

export function LoginPage() {
  const navigate = useNavigate();
  const setupStatus = useQuery(setupStatusQueryOptions);
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    if (!password) {
      setError("Enter your password.");
      return;
    }

    setSubmitting(true);
    try {
      await api.login({
        username: username.trim() || "owner",
        password,
      });
      await prepareFreshSession();
      toast.success("Signed in.");
      // Stay in the SPA; direct /today reloads still need the server's SPA
      // fallback (M0 infra) or an active service worker.
      void navigate({ href: nextPathFromLocation(), replace: true });
    } catch (submitError) {
      if (isApiError(submitError) && submitError.status === 401) {
        setError("That password didn’t match. Try again.");
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
        <p className="label-caps">Morrow</p>
        <h1 className="serif mt-2 text-28 md:text-[2rem] md:leading-[2.25rem]">
          Welcome back.
        </h1>
        <p className="mt-2 text-13 leading-relaxed text-muted">
          Your reminders kept their place.
        </p>
      </div>

      <form
        className="mt-7 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor="login-username" className="field-label">
            Username
          </label>
          <input
            id="login-username"
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="login-password" className="field-label">
            Password
          </label>
          <div className="relative">
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              className="input pr-12"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
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
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-13 text-danger"
          >
            {error}
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
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </form>

      {setupStatus.data?.setupRequired === true ? (
        <>
          <div className="mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
            <span className="text-12 text-faint">First time here?</span>
            <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
          </div>

          <p className="mt-5 text-center text-13 text-muted">
            Set up Morrow with the one-time token.{" "}
            <Link
              to="/setup"
              className="font-medium text-accent underline underline-offset-2"
            >
              Open setup
            </Link>
          </p>
        </>
      ) : null}
    </AuthLayout>
  );
}
