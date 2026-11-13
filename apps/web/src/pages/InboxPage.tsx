import { Inbox, Plus } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TaskGroup } from "@/components/TaskGroup";
import { LoadMoreButton, TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useShell } from "@/components/shell-context";
import { isOpenTask, plural, sortTasks, taskDayKey } from "@/lib/format";
import { useAppData, useTaskListData } from "@/lib/queries";

export function InboxPage() {
  const { lists } = useAppData();
  const view = useTaskListData({ view: "inbox" });
  const { openCapture } = useShell();
  const unscheduled = view.tasks
    .filter((task) => isOpenTask(task) && !taskDayKey(task))
    .sort(sortTasks);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={<span className="label-caps">No date, no pressure</span>}
        title="Inbox"
        description={
          unscheduled.length > 0
            ? `${unscheduled.length} ${plural(
                unscheduled.length,
                "reminder",
              )} waiting for a date.`
            : "Everything without a home lands here."
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
      ) : unscheduled.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Inbox className="h-5 w-5" aria-hidden="true" />}
            title="Inbox zero."
            description="Anything added without a date waits here. Give it a date when you’re ready."
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
            title="Unscheduled"
            tasks={unscheduled}
            lists={lists}
            showList
          />
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
