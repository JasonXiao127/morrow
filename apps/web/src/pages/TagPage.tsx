import { Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, Tags } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TaskGroup } from "@/components/TaskGroup";
import { LoadMoreButton, TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useShell } from "@/components/shell-context";
import { isOpenTask, plural, sortTasks } from "@/lib/format";
import { useAppData, useTaskListData } from "@/lib/queries";

export function TagPage({ tagId }: { tagId: string }) {
  const { tags, lists } = useAppData();
  const { openCapture } = useShell();
  const tag = tags.find((entry) => entry.id === tagId);
  const view = useTaskListData({ tagId });
  const open = view.tasks.filter(isOpenTask).sort(sortTasks);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={
          <Link
            to="/today"
            className="label-caps inline-flex min-h-11 items-center gap-1.5 hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Today
          </Link>
        }
        title={
          <span className="flex items-center gap-2.5">
            <Tags className="h-5 w-5 text-muted" aria-hidden="true" />
            {tag?.name ?? "Tag"}
          </span>
        }
        description={`${open.length} open ${plural(open.length, "task")} with this tag.`}
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
      ) : open.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Tags className="h-5 w-5" aria-hidden="true" />}
            title="No tasks with this tag."
            description="Add the tag in a task’s details, or capture something new."
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
          <TaskGroup title={tag?.name ?? "Tagged"} tasks={open} lists={lists} showList />
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
