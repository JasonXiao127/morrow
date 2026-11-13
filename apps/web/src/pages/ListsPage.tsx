import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, List, Plus } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { NewListDialog } from "@/components/NewListDialog";
import { PageHeader } from "@/components/PageHeader";
import { TaskListSkeleton } from "@/components/TaskListStates";
import { useShell } from "@/components/shell-context";
import {
  isOpenTask,
  listColorSlug,
  listDisplayName,
  plural,
} from "@/lib/format";
import { useAppData } from "@/lib/queries";

export function ListsPage() {
  const { lists, tasks, query } = useAppData();
  const { openCapture } = useShell();
  const [newListOpen, setNewListOpen] = useState(false);

  const openTasks = tasks.filter(isOpenTask);
  const countFor = (listId: string) =>
    openTasks.filter((task) => task.listId === listId).length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={<span className="label-caps">Contexts, not folders</span>}
        title="Lists"
        description="Optional homes for related reminders. Today and Inbox work without them."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setNewListOpen(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New list
            </button>
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
      />

      {query.isPending ? (
        <TaskListSkeleton rows={4} />
      ) : lists.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<List className="h-5 w-5" aria-hidden="true" />}
            title="No lists yet."
            description="Lists are optional. Inbox and Today work without them; a list just gives related reminders a name."
            action={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setNewListOpen(true)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Make the first list
              </button>
            }
          />
        </div>
      ) : (
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {lists.map((list) => {
            const count = countFor(list.id);
            return (
              <Link
                key={list.id}
                to="/lists/$listId"
                params={{ listId: list.id }}
                data-list-color={listColorSlug(list.color)}
                aria-label={`${listDisplayName(list)}, ${count} open ${plural(count, "task")}`}
                className="group flex min-h-32 flex-col justify-between rounded-lg border border-hairline bg-surface p-4 transition-colors hover:border-hairline-strong hover:bg-selection/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="list-dot mt-2" aria-hidden="true" />
                  <ArrowUpRight
                    className="h-4 w-4 text-faint transition-colors group-hover:text-accent"
                    aria-hidden="true"
                  />
                </div>
                <div className="mt-5">
                  <h2 className="serif text-22 text-ink">
                    {listDisplayName(list)}
                  </h2>
                  <p className="mt-1 text-12 text-muted">
                    {count} open {plural(count, "task")}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <NewListDialog open={newListOpen} onOpenChange={setNewListOpen} />
    </div>
  );
}
