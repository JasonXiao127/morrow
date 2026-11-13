import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import { isApiError } from "@/api";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TaskDetail } from "@/components/TaskDetail";
import { TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useAppData, useTaskDetail } from "@/lib/queries";

export function TaskDetailPage() {
  const { taskId } = useParams({ from: "/_app/tasks/$taskId" });
  const { lists } = useAppData();
  const query = useTaskDetail(taskId);
  const task = query.data;

  if (query.isPending) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
        <TaskListSkeleton rows={2} />
      </div>
    );
  }

  if (!task) {
    const missing =
      isApiError(query.error) &&
      (query.error.status === 404 || query.error.status === 410);
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <PageHeader
          eyebrow="Task"
          title="Task not found"
          description="It may have been completed, deleted, or created on another device."
          actions={
            <Link to="/today" className="btn btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Today
            </Link>
          }
        />
        <div className="mt-8">
          {missing || !query.isError ? (
            <EmptyState
              icon={<Check className="h-5 w-5" aria-hidden="true" />}
              title="This task isn’t here."
              description="Recently deleted keeps a copy for 30 days. Restore it from the trash."
            />
          ) : (
            <TaskListError
              error={query.error}
              onRetry={() => void query.refetch()}
              isRetrying={query.isFetching}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full w-full max-w-4xl border-x border-hairline bg-surface">
      <TaskDetail task={task} lists={lists} variant="page" />
    </div>
  );
}
