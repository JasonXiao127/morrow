import { useEffect } from "react";
import { Outlet, createRootRouteWithContext, createRoute, createRouter, redirect } from "@tanstack/react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";
import { ApiError } from "@/api";
import { App, ShellSkeleton } from "@/App";
import { ErrorPage, NotFoundPage } from "@/pages/ErrorPages";
import { AssistantPage } from "@/pages/AssistantPage";
import { CalendarPage } from "@/pages/CalendarPage";
import { InboxPage } from "@/pages/InboxPage";
import { InstallPage } from "@/pages/InstallPage";
import { ListPage } from "@/pages/ListPage";
import { ListsPage } from "@/pages/ListsPage";
import { LoginPage } from "@/pages/LoginPage";
import { ProposalPage } from "@/pages/ProposalPage";
import { RecentlyDeletedPage } from "@/pages/RecentlyDeletedPage";
import { SessionExpiredPage } from "@/pages/SessionExpiredPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TagPage } from "@/pages/TagPage";
import { SetupPage } from "@/pages/SetupPage";
import { TaskDetailPage } from "@/pages/TaskDetailPage";
import { TodayPage } from "@/pages/TodayPage";
import { UpcomingPage } from "@/pages/UpcomingPage";
import {
  bootstrapQueryOptions,
  queryClient,
  queryKeys,
  setupStatusQueryOptions,
} from "@/lib/query";
import { replayOutboxBeforeBootstrap } from "@/lib/outbox";
import { applyServiceWorkerUpdate, onServiceWorkerUpdate } from "@/lib/pwa";
import { endSession } from "@/lib/session";
import { useTheme } from "@/lib/theme";

export interface RouterContext {
  queryClient: QueryClient;
}

function RootComponent() {
  const { resolved } = useTheme();

  // Prompt-based service worker update; never blind skipWaiting. Mounted at
  // the root so setup, login, and session-expired screens can also escape a
  // stale cached shell.
  useEffect(
    () =>
      onServiceWorkerUpdate(() => {
        toast("A new version of Morrow is ready.", {
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: "Reload",
            onClick: () => {
              void applyServiceWorkerUpdate();
            },
          },
        });
      }),
    [],
  );

  return (
    <Tooltip.Provider delayDuration={350}>
      <Outlet />
      <Toaster
        theme={resolved}
        position="bottom-right"
        closeButton
        toastOptions={{
          duration: 5_000,
        }}
      />
    </Tooltip.Provider>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ({ error }) => <ErrorPage error={error} />,
  notFoundComponent: NotFoundPage,
});

/** null means the probe failed; callers fall back to the previous behaviour. */
async function setupRequired(
  context: RouterContext,
): Promise<boolean | null> {
  try {
    const status = await context.queryClient.ensureQueryData(
      setupStatusQueryOptions,
    );
    return status.setupRequired;
  } catch {
    return null;
  }
}

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if ((await setupRequired(context)) === false) {
      throw redirect({ to: "/login", replace: true });
    }
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string } => ({
    next: typeof search["next"] === "string" ? search["next"] : undefined,
  }),
  beforeLoad: async ({ context }) => {
    if ((await setupRequired(context)) === true) {
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: LoginPage,
});

const sessionExpiredRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session-expired",
  beforeLoad: async ({ context }) => {
    if ((await setupRequired(context)) === true) {
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: SessionExpiredPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    const required = await setupRequired(context);
    throw redirect({
      to: required === true ? "/setup" : "/today",
      replace: true,
    });
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  component: App,
  pendingComponent: ShellSkeleton,
  beforeLoad: async ({ context }) => {
    // Replay unacked offline operations BEFORE bootstrap can replace the
    // cached snapshot (plan §7). A failure here must not block login; the
    // outbox banner keeps the queued work visible.
    try {
      await replayOutboxBeforeBootstrap();
    } catch {
      // IndexedDB/Lock failures fall through to bootstrap.
    }
    try {
      await context.queryClient.ensureQueryData(bootstrapQueryOptions);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await endSession({ expired: true });
        context.queryClient.removeQueries({ queryKey: queryKeys.bootstrap });
        // A cold visit without a session is a sign-in, not an expiry story.
        // The mounted shell still routes real expiries to /session-expired
        // through the morrow:session-expired event.
        const required = await setupRequired(context);
        throw redirect({
          to: required === true ? "/setup" : "/login",
          replace: true,
        });
      }
      // Network/5xx: let the shell render its honest connection state so the
      // retry button and persisted cache can do their job.
    }
  },
});

const todayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/today",
  component: TodayPage,
});

const upcomingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/upcoming",
  component: UpcomingPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/inbox",
  component: InboxPage,
});

const calendarRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/calendar",
  component: CalendarPage,
});

const listsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/lists",
  component: ListsPage,
});

const listRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/lists/$listId",
  component: ListPage,
});

const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

const tagRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/tags/$tagId",
  component: function TagRoute() {
    const { tagId } = tagRoute.useParams();
    return <TagPage tagId={tagId} />;
  },
});

const assistantRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/assistant",
  component: AssistantPage,
});

const proposalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/proposal/$proposalId",
  component: ProposalPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: string } => ({
    section:
      typeof search["section"] === "string" ? search["section"] : undefined,
  }),
  component: SettingsPage,
});

const trashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/trash",
  component: RecentlyDeletedPage,
});

const installRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/install",
  component: InstallPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  loginRoute,
  sessionExpiredRoute,
  appRoute.addChildren([
    todayRoute,
    upcomingRoute,
    inboxRoute,
    calendarRoute,
    listsRoute,
    listRoute,
    taskRoute,
    tagRoute,
    assistantRoute,
    proposalRoute,
    settingsRoute,
    trashRoute,
    installRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 15_000,
  scrollRestoration: true,
  defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
