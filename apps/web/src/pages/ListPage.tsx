import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  List as ListIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage, authApi, listApi } from "@/api";
import { DialogFrame } from "@/components/DialogFrame";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { CompletedGroup, TaskGroup } from "@/components/TaskGroup";
import { LoadMoreButton, TaskListError, TaskListSkeleton } from "@/components/TaskListStates";
import { useShell } from "@/components/shell-context";
import {
  isDoneTask,
  isOpenTask,
  listColorSlug,
  listDisplayName,
  plural,
  sortTasks,
} from "@/lib/format";
import {
  useAppData,
  useDeleteList,
  useTaskListData,
  useUpdateList,
} from "@/lib/queries";

export function ListPage() {
  const { listId } = useParams({ from: "/_app/lists/$listId" });
  const navigate = useNavigate();
  const { lists, tasks: bootstrapTasks, query: bootstrapQuery } = useAppData();
  const view = useTaskListData({ listId, includeDone: true });
  const { openCapture } = useShell();
  const updateList = useUpdateList();
  const deleteList = useDeleteList();

  const list = lists.find((candidate) => candidate.id === listId);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("persimmon");
  const [formError, setFormError] = useState<string | null>(null);
  const [members, setMembers] = useState<
    Array<{ id: string; username: string; timezone: string; role: string }>
  >([]);
  const [shareUsername, setShareUsername] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    if (renameOpen && list) {
      setName(listDisplayName(list));
      setColor(listColorSlug(list.color));
      setFormError(null);
    }
  }, [list, renameOpen]);

  useEffect(() => {
    if (!shareOpen || !list) return;
    setShareError(null);
    setShareUsername("");
    setSharePassword("");
    void listApi
      .members(list.id)
      .then(setMembers)
      .catch((error) => setShareError(apiErrorMessage(error)));
  }, [list, shareOpen]);

  const addMember = async () => {
    if (!list || !shareUsername.trim()) return;
    setShareError(null);
    setShareBusy(true);
    try {
      if (!sharePassword) {
        setShareError("Confirm your password to share this list.");
        return;
      }
      await authApi.stepUp(sharePassword);
      await listApi.share(list.id, shareUsername.trim().toLowerCase());
      setMembers(await listApi.members(list.id));
      setShareUsername("");
      toast.success("List shared.");
    } catch (error) {
      setShareError(apiErrorMessage(error));
    } finally {
      setShareBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    if (!list) return;
    setShareError(null);
    setShareBusy(true);
    try {
      if (!sharePassword) {
        setShareError("Confirm your password to change access.");
        return;
      }
      await authApi.stepUp(sharePassword);
      await listApi.unshare(list.id, userId);
      setMembers(await listApi.members(list.id));
      toast.success("Access removed.");
    } catch (error) {
      setShareError(apiErrorMessage(error));
    } finally {
      setShareBusy(false);
    }
  };

  if (!list) {
    if (bootstrapQuery.isPending) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
          <TaskListSkeleton rows={3} />
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
        <PageHeader
          eyebrow="List"
          title="List not found"
          description="It may have been deleted on another device."
          actions={
            <Link to="/lists" className="btn btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              All lists
            </Link>
          }
        />
        <div className="mt-8">
          <EmptyState
            icon={<ListIcon className="h-5 w-5" aria-hidden="true" />}
            title="This list slipped away."
            description="Recently deleted keeps a copy for 30 days. Restore it from the trash."
          />
        </div>
      </div>
    );
  }

  const open = view.tasks.filter(isOpenTask).sort(sortTasks);
  const done = new Map<string, (typeof bootstrapTasks)[number]>();
  for (const task of view.tasks.filter(isDoneTask)) done.set(task.id, task);
  for (const task of bootstrapTasks.filter(
    (candidate) => candidate.listId === list.id && isDoneTask(candidate),
  )) {
    done.set(task.id, task);
  }
  const completed = Array.from(done.values()).sort((a, b) =>
    (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
  );

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("A list needs a name.");
      return;
    }
    setFormError(null);
    try {
      await updateList.mutateAsync({
        list,
        patch: { name: trimmed, color: color || null },
      });
      setRenameOpen(false);
    } catch (error) {
      setFormError(apiErrorMessage(error));
    }
  };

  return (
    <div
      className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8"
      data-list-color={listColorSlug(list.color)}
    >
      <PageHeader
        eyebrow={
          <Link
            to="/lists"
            className="label-caps inline-flex min-h-11 items-center gap-1.5 hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            All lists
          </Link>
        }
        title={
          <span className="flex items-center gap-2.5">
            <span className="list-dot h-3 w-3" aria-hidden="true" />
            {listDisplayName(list)}
          </span>
        }
        description={`${open.length} open ${plural(open.length, "task")}.`}
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openCapture(list.id)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="icon-btn border border-hairline-strong"
                  aria-label={`Actions for ${listDisplayName(list)}`}
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-[60] min-w-52 rounded-md border border-hairline bg-canvas p-1 text-13 shadow-lg"
                >
                  {!list.shared ? (
                    <DropdownMenu.Item
                      onSelect={() => setRenameOpen(true)}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                    >
                      <Pencil className="h-4 w-4 text-muted" aria-hidden="true" />
                      Rename list
                    </DropdownMenu.Item>
                  ) : null}
                  <DropdownMenu.Item
                    onSelect={() => setShareOpen(true)}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                  >
                    <Share2 className="h-4 w-4 text-muted" aria-hidden="true" />
                    {list.shared ? "Members" : "Share list"}
                  </DropdownMenu.Item>
                  {!list.shared ? (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                      <DropdownMenu.Item
                        onSelect={() => setDeleteOpen(true)}
                        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-danger outline-none data-[highlighted]:bg-danger-soft"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Delete list
                      </DropdownMenu.Item>
                    </>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
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
      ) : open.length === 0 && completed.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<ListIcon className="h-5 w-5" aria-hidden="true" />}
            title="This list is quiet."
            description="Add the first reminder, or leave it empty until it earns its place."
            action={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openCapture(list.id)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add to this list
              </button>
            }
          />
        </div>
      ) : (
        <div className="mt-7">
          <TaskGroup title="Open" tasks={open} lists={lists} />
          <CompletedGroup tasks={completed} lists={lists} />
          <LoadMoreButton
            hasNextPage={view.hasNextPage}
            isFetching={view.isFetchingNextPage}
            onClick={view.fetchNextPage}
          />
        </div>
      )}

      <DialogFrame
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename list"
        description="Give related reminders a clearer name."
      >
        <form
          className="p-5 md:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <h2 className="serif text-22">Rename list</h2>
          <p className="mt-1 text-13 text-muted">
            Tasks stay where they are; only the name changes.
          </p>
          <div className="mt-4">
            <label htmlFor="list-rename" className="field-label">
              Name
            </label>
            <input
              id="list-rename"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              maxLength={200}
            />
          </div>
          <div className="mt-3">
            <span className="field-label">Colour</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {["persimmon", "moss", "ochre", "slate", "plum", "rose"].map(
                (option) => (
                  <button
                    key={option}
                    type="button"
                    data-list-color={option}
                    aria-label={option}
                    aria-pressed={color === option}
                    className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent hover:bg-selection aria-pressed:border-hairline-strong aria-pressed:bg-selection"
                    onClick={() => setColor(option)}
                  >
                    <span className="list-dot h-4 w-4" aria-hidden="true" />
                  </button>
                ),
              )}
            </div>
          </div>
          {formError ? (
            <p role="alert" className="mt-3 text-13 text-danger">
              {formError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRenameOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={updateList.isPending}
              aria-busy={updateList.isPending}
            >
              {updateList.isPending ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      </DialogFrame>

      <DialogFrame
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${listDisplayName(list)}`}
        description="The list is soft-deleted; its tasks stay."
      >
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">Delete this list?</h2>
          <p className="mt-2 text-13 leading-relaxed text-muted">
            The list is removed, but its tasks are kept. Tasks without a list
            still appear in Inbox and Today. Restore the list from Recently
            deleted within 30 days.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteList.isPending}
              aria-busy={deleteList.isPending}
              onClick={() => {
                deleteList.mutate(list, {
                  onSuccess: () => {
                    setDeleteOpen(false);
                    void navigate({ to: "/lists" });
                  },
                  onError: (error) => toast.error(apiErrorMessage(error)),
                });
              }}
            >
              {deleteList.isPending ? "Deleting…" : "Delete list"}
            </button>
          </div>
        </div>
      </DialogFrame>

      <DialogFrame
        open={shareOpen}
        onOpenChange={setShareOpen}
        title={`Share ${listDisplayName(list)}`}
        description="People can see and edit tasks in this list. Their own lists stay private."
      >
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">List access</h2>
          <p className="mt-1 text-13 text-muted">
            {list.shared
              ? "You are a member of this shared list. Only the owner can change access."
              : "Add another account by username. They can edit tasks in this list."}
          </p>

          <ul className="mt-4 divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-canvas">
            {members.map((member) => (
              <li key={member.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-surface text-11 font-semibold text-accent">
                  {member.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-13 text-ink-soft">{member.username}</p>
                  <p className="text-11 text-faint">{member.role}</p>
                </div>
                {!list.shared && member.role !== "owner" ? (
                  <button
                    type="button"
                    className="btn btn-ghost min-h-9 px-2 text-12 text-danger"
                    onClick={() => void removeMember(member.id)}
                    disabled={shareBusy}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {!list.shared ? (
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void addMember();
              }}
            >
              <label className="grid gap-1.5">
                <span className="field-label">Username</span>
                <input
                  className="input"
                  value={shareUsername}
                  onChange={(event) => setShareUsername(event.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="grid gap-1.5">
                <span className="field-label">Your password (step-up)</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={sharePassword}
                  onChange={(event) => setSharePassword(event.target.value)}
                />
              </label>
              <div className="flex justify-end sm:col-span-2">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={shareBusy || !shareUsername.trim() || !sharePassword}
                >
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                  {shareBusy ? "Saving…" : "Share"}
                </button>
              </div>
            </form>
          ) : null}

          {shareError ? (
            <p role="alert" className="mt-3 text-13 text-danger">
              {shareError}
            </p>
          ) : null}
        </div>
      </DialogFrame>
    </div>
  );
}
