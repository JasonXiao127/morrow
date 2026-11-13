import { Plus, Sparkles, Sun } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArmedState } from "@/components/ArmedState";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { CompletedGroup, TaskGroup } from "@/components/TaskGroup";
import { LoadMoreButton, TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { ProposalCard } from "@/components/ProposalCard";
import { useShell } from "@/components/shell-context";
import {
  dateKeyInZone,
  formatLongDate,
  isDoneTask,
  isOpenTask,
  isTaskBeforeToday,
  isTaskDueToday,
  isTaskOverdue,
  plural,
  sortTasks,
  todayKeyInZone,
} from "@/lib/format";
import { useAppData, useTaskListData } from "@/lib/queries";
import { usePlanMyDay, useProposals } from "@/lib/assistant";

export function TodayPage() {
  const { tasks: bootstrapTasks, lists, user } = useAppData();
  const isOwner = user?.role === "owner";
  const zone = user?.timezone ?? undefined;
  const view = useTaskListData({ view: "today" });
  const { openCapture } = useShell();
  const navigate = useNavigate();
  const plan = usePlanMyDay();
  const recentProposals = useProposals("all", isOwner);
  const pending = (recentProposals.data?.proposals ?? []).filter(
    (proposal) => proposal.status === "pending",
  );
  const recentlyApplied = (recentProposals.data?.proposals ?? []).find(
    (proposal) =>
      proposal.status === "applied" &&
      Date.now() - Date.parse(proposal.updatedAt) < 15 * 60_000,
  );
  const nextProposal = pending[0] ?? recentlyApplied ?? null;
  const now = new Date();

  const open = view.tasks.filter(isOpenTask).sort(sortTasks);
  const overdue = open.filter((task) => isTaskBeforeToday(task, now, zone));
  const dueToday = open.filter(
    (task) =>
      isTaskDueToday(task, now, zone) &&
      !isTaskBeforeToday(task, now, zone),
  );
  // The Today view is open work; completed-today comes from the real bootstrap
  // snapshot (invalidated after every write) until the server includes it.
  const completedToday = bootstrapTasks
    .filter((task) => {
      if (!isDoneTask(task) || !task.completedAt) return false;
      const completed = new Date(task.completedAt);
      return (
        !Number.isNaN(completed.getTime()) &&
        dateKeyInZone(completed, zone) === todayKeyInZone(zone, now)
      );
    })
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  const total = overdue.length + dueToday.length;
  const overdueCount = open.filter(isTaskOverdue).length;
  const summary =
    total === 0
      ? "No reminders due. Enjoy the clear list."
      : `${total} ${plural(total, "reminder")}${
          overdueCount > 0 ? ` · ${overdueCount} overdue` : ""
        }`;

  const planMyDay = () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    plan.mutate({ timezone });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        bordered={false}
        eyebrow={
          <span className="serif text-17 text-muted">
            {formatLongDate(now, zone)}
          </span>
        }
        title="Today"
        description={summary}
        actions={
          <>
            {isOwner ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={planMyDay}
                disabled={plan.isPending}
                aria-busy={plan.isPending}
                title="Propose a plan for today without changing anything"
              >
                <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {plan.isPending ? "Planning…" : "Plan my day"}
                </span>
                <span className="sm:hidden">
                  {plan.isPending ? "…" : "Plan"}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openCapture()}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </button>
          </>
        }
      >
        <ArmedState />
      </PageHeader>

      {nextProposal ? (
        <div className="mt-5">
          <ProposalCard
            proposal={nextProposal}
            compact
            onReview={() => void navigate({ to: "/assistant" })}
          />
          {pending.length > 1 ? (
            <Link
              to="/assistant"
              className="mt-2 inline-block text-12 text-accent underline underline-offset-2"
            >
              {pending.length - 1} more proposal
              {pending.length - 1 === 1 ? "" : "s"} in the assistant
            </Link>
          ) : null}
        </div>
      ) : null}

      {view.isPending ? (
        <TaskListSkeleton rows={4} />
      ) : view.isError && view.tasks.length === 0 ? (
        <TaskListError
          error={view.error}
          onRetry={view.refetch}
          isRetrying={view.isFetching}
        />
      ) : total === 0 && completedToday.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Sun className="h-5 w-5" aria-hidden="true" />}
            title="No reminders today."
            description="Add one above to get started."
            action={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openCapture()}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add reminder
              </button>
            }
          />
        </div>
      ) : (
        <div className="mt-7">
          <TaskGroup
            title="Overdue"
            tasks={overdue}
            lists={lists}
            showList
            tone="overdue"
          />
          <TaskGroup title="Today" tasks={dueToday} lists={lists} showList />
          <CompletedGroup tasks={completedToday} lists={lists} showList />
          <LoadMoreButton
            hasNextPage={view.hasNextPage}
            isFetching={view.isFetchingNextPage}
            onClick={view.fetchNextPage}
          />
        </div>
      )}
    </div>
  );
}
