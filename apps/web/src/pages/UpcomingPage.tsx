import { CalendarDays, Plus } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TaskGroup } from "@/components/TaskGroup";
import { LoadMoreButton, TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useShell } from "@/components/shell-context";
import {
  formatGroupDate,
  formatMonthYear,
  groupTasksByDay,
  isOpenTask,
  plural,
  sortTasks,
} from "@/lib/format";
import { useAppData, useTaskListData } from "@/lib/queries";

export function UpcomingPage() {
  const { lists, user } = useAppData();
  const view = useTaskListData({ view: "upcoming" });
  const { openCapture } = useShell();
  const now = new Date();
  const zone = user?.timezone ?? undefined;
  const upcoming = view.tasks.filter(isOpenTask).sort(sortTasks);
  const groups = groupTasksByDay(upcoming, zone);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={
          <span className="serif text-17 text-muted">
            {formatMonthYear(now, zone)}
          </span>
        }
        title="Upcoming"
        description={
          upcoming.length > 0
            ? `${upcoming.length} ${plural(upcoming.length, "reminder")} ahead. No month grid, just what’s next.`
            : "No month grid. Just what’s next."
        }
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openCapture()}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </button>
        }
      />

      {view.isPending ? (
        <TaskListSkeleton rows={4} />
      ) : view.isError && view.tasks.length === 0 ? (
        <TaskListError
          error={view.error}
          onRetry={view.refetch}
          isRetrying={view.isFetching}
        />
      ) : groups.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" aria-hidden="true" />}
            title="Nothing ahead."
            description="A clear horizon. When something appears, it will show up here — no month grid."
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
          {groups.map((group) => (
            <TaskGroup
              key={group.key}
              title={formatGroupDate(group.key, now, zone)}
              tasks={group.tasks}
              lists={lists}
              showList
              variant="day"
            />
          ))}
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
