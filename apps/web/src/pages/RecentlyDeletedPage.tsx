import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  activityApi,
  apiErrorMessage,
  authApi,
  normalizeList,
  normalizeTask,
  trashApi,
  type Task,
  type TaskList,
} from "@/api";
import { Announcer } from "@/components/Announcer";
import { DialogFrame } from "@/components/DialogFrame";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { announce } from "@/lib/announce";
import { formatTimestamp, listDisplayName } from "@/lib/format";
import { invalidateTaskQueries, queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";

type TrashKind = "task" | "list";

interface PurgeTarget {
  kind: TrashKind;
  id: string;
  title: string;
}

const TRASH_QUERY_KEY = ["trash"] as const;

function useTrash() {
  return useQuery({
    queryKey: TRASH_QUERY_KEY,
    queryFn: () => trashApi.list(),
    staleTime: 15_000,
    retry: false,
  });
}

function useTrashClient() {
  return useQueryClient();
}

function PurgeDialog({
  target,
  onClose,
  onPurged,
}: {
  target: PurgeTarget | null;
  onClose: () => void;
  onPurged: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expected = target?.title ?? "";
  const confirmOk =
    expected.length > 0 && confirm.trim() === expected.trim();

  const purge = async () => {
    if (!target) return;
    if (!confirmOk) {
      setError(`Type “${expected}” to confirm.`);
      return;
    }
    if (!password) {
      setError("Enter your password — purging needs a fresh confirmation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Step-up first: DELETE returns 403 step_up_required without it.
      await authApi.stepUp(password);
      if (target.kind === "task") await trashApi.purgeTask(target.id);
      else await trashApi.purgeList(target.id);
      announce(`Permanently deleted ${target.title}.`);
      toast.success("Permanently deleted.", {
        description: `“${target.title}” cannot be restored.`,
      });
      onPurged();
      onClose();
    } catch (error) {
      setError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setConfirm("");
          setPassword("");
          setError(null);
          onClose();
        }
      }}
      title={target ? `Permanently delete ${target.title}` : "Permanently delete"}
      description="Purging cannot be undone. A password confirmation is required."
    >
      {target ? (
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">Purge “{target.title}”?</h2>
          <p className="mt-2 text-13 leading-relaxed text-muted">
            This permanently deletes the {target.kind}. It cannot be restored
            and cannot be undone. Purging needs a fresh password confirmation
            (step-up) — your session alone is not enough.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="purge-confirm" className="field-label">
                Type “{expected}” to confirm
              </label>
              <input
                id="purge-confirm"
                className="input mono text-13"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                placeholder={expected}
              />
            </div>
            <div>
              <label htmlFor="purge-password" className="field-label">
                Password (step-up)
              </label>
              <input
                id="purge-password"
                type="password"
                className="input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Your Morrow password"
              />
              <p className="field-help">
                Confirms it is really you. Required once per session for
                destructive actions.
              </p>
            </div>
            {error ? (
              <p role="alert" className="text-13 text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void purge()}
              disabled={busy || !confirmOk || !password}
              aria-busy={busy}
            >
              {busy ? "Purging…" : "Purge forever"}
            </button>
          </div>
        </div>
      ) : null}
    </DialogFrame>
  );
}

export function RecentlyDeletedPage() {
  const queryClient = useTrashClient();
  const trash = useTrash();
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    await invalidateTaskQueries(queryClient);
  };

  const undoRestore = (kind: TrashKind, id: string, title: string) => {
    toast.success(`Restored “${title}”.`, {
      description: "Undo is available for a moment.",
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            try {
              const seq = await activityApi.undoLatest({
                entityId: id,
                action: kind === "task" ? "task.restore" : "list.restore",
                fromCursor: 0,
              });
              if (seq === null) {
                toast("Nothing to undo", {
                  description: "The restore is no longer in recent history.",
                });
                return;
              }
              await refresh();
              announce(`Undid restore of ${title}.`);
            } catch (error) {
              toast.error(apiErrorMessage(error));
            }
          })();
        },
      },
    });
  };

  const restoreTask = useMutation({
    mutationFn: (task: Task) => trashApi.restoreTask(task.id),
    onSuccess: async (restored) => {
      await refresh();
      announce(`Restored ${restored.title}.`);
      undoRestore("task", restored.id, restored.title);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const restoreList = useMutation({
    mutationFn: (list: TaskList) => trashApi.restoreList(list.id),
    onSuccess: async (restored) => {
      await refresh();
      const title = listDisplayName(restored);
      announce(`Restored list ${title}.`);
      undoRestore("list", restored.id, title);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const tasks = useMemo(
    () =>
      (trash.data?.tasks ?? [])
        .map((task) =>
          normalizeTask({ ...task, deletedAt: task.deletedAt ?? task.deleted_at }),
        )
        .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")),
    [trash.data],
  );
  const lists = useMemo(
    () =>
      (trash.data?.lists ?? [])
        .map((list) => normalizeList(list))
        .sort((a, b) =>
          String(b.updatedAt ?? b.updated_at ?? "").localeCompare(
            String(a.updatedAt ?? a.updated_at ?? ""),
          ),
        ),
    [trash.data],
  );
  const total = tasks.length + lists.length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <Announcer />
      <PageHeader
        eyebrow={<span className="label-caps">Soft delete · 30 days</span>}
        title="Recently deleted"
        description="Restore brings a task or list back with a revision bump. Purging is permanent and needs a password confirmation."
        actions={
          total > 0 ? (
            <span
              className="inline-flex min-h-11 items-center rounded-sm border border-hairline px-2.5 text-12 text-muted"
              aria-live="polite"
            >
              {total} {total === 1 ? "item" : "items"}
            </span>
          ) : undefined
        }
      />

      {trash.isPending ? (
        <div className="mt-8">
          <TaskListSkeleton rows={3} />
        </div>
      ) : trash.isError ? (
        <div className="mt-8">
          <TaskListError
            error={trash.error}
            onRetry={() => void trash.refetch()}
            isRetrying={trash.isFetching}
          />
        </div>
      ) : total === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<Trash2 className="h-5 w-5" aria-hidden="true" />}
            title="The bin is empty."
            description="Deleted tasks and lists wait here for 30 days before the nightly cleanup. Nothing is gone forever until then."
          />
        </div>
      ) : (
        <div className="mt-7 space-y-6">
          {lists.length > 0 ? (
            <section aria-labelledby="trash-lists-heading">
              <h2
                id="trash-lists-heading"
                className="label-caps mb-2"
              >
                Lists · {lists.length}
              </h2>
              <ul className="divide-y divide-hairline border-y border-hairline">
                {lists.map((list) => {
                  const title = listDisplayName(list);
                  const busy =
                    restoreList.isPending &&
                    restoreList.variables?.id === list.id;
                  return (
                    <li
                      key={list.id}
                      className="flex flex-wrap items-center gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-13 font-medium text-ink-soft">
                          {title}
                        </p>
                        <p className="mt-0.5 text-12 text-faint">
                          List · deleted{" "}
                          {formatTimestamp(
                            typeof list.deletedAt === "string"
                              ? list.deletedAt
                              : typeof list.deleted_at === "string"
                                ? (list.deleted_at as string)
                                : null,
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary min-h-11 px-3 text-12"
                          onClick={() => restoreList.mutate(list)}
                          disabled={busy}
                          aria-busy={busy}
                        >
                          <RotateCcw
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          {busy ? "Restoring…" : "Restore"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger min-h-11 px-3 text-12"
                          onClick={() =>
                            setPurgeTarget({
                              kind: "list",
                              id: list.id,
                              title,
                            })
                          }
                        >
                          Purge
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {tasks.length > 0 ? (
            <section aria-labelledby="trash-tasks-heading">
              <h2
                id="trash-tasks-heading"
                className="label-caps mb-2"
              >
                Tasks · {tasks.length}
              </h2>
              <ul className="divide-y divide-hairline border-y border-hairline">
                {tasks.map((task) => {
                  const busy =
                    restoreTask.isPending &&
                    restoreTask.variables?.id === task.id;
                  return (
                    <li
                      key={task.id}
                      className="flex flex-wrap items-center gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate text-13 text-ink-soft",
                            task.status === "done" && "line-through",
                          )}
                        >
                          {task.title}
                        </p>
                        <p className="mt-0.5 text-12 text-faint">
                          deleted {formatTimestamp(task.deletedAt)}
                          {typeof task.rev === "number"
                            ? ` · rev ${task.rev} → ${task.rev + 1} on restore`
                            : null}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary min-h-11 px-3 text-12"
                          onClick={() => restoreTask.mutate(task)}
                          disabled={busy}
                          aria-busy={busy}
                        >
                          <RotateCcw
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          {busy ? "Restoring…" : "Restore"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger min-h-11 px-3 text-12"
                          onClick={() =>
                            setPurgeTarget({
                              kind: "task",
                              id: task.id,
                              title: task.title,
                            })
                          }
                        >
                          Purge
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <p className="text-12 leading-relaxed text-faint">
            Restoring bumps the revision so other devices pick it up. Purging
            permanently deletes and needs a typed confirmation plus your
            password.
          </p>
        </div>
      )}

      <PurgeDialog
        target={purgeTarget}
        onClose={() => setPurgeTarget(null)}
        onPurged={() => void refresh()}
      />
    </div>
  );
}
