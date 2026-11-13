import { useRef, useState } from "react";
import {
  Check,
  Download,
  FileText,
  Paperclip,
  Plus,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Attachment, Subtask, Tag, Task } from "@/api";
import { cn } from "@/lib/utils";
import {
  useAttachments,
  useAttachmentMutations,
  useCreateTag,
  useSetTaskTags,
  useSubtaskMutations,
  useSubtasks,
  useTags,
  useTaskTags,
} from "@/lib/product";

function Chip({
  tag,
  selected,
  onClick,
}: {
  tag: Tag;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-12 transition-colors",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-hairline bg-canvas text-muted hover:border-hairline-strong hover:text-ink",
      )}
    >
      <span
        className="h-2 w-2 rounded-full bg-current opacity-70"
        aria-hidden="true"
      />
      {tag.name}
    </button>
  );
}

export function TaskTagsSection({ task }: { task: Task }) {
  const allTags = useTags();
  const selected = useTaskTags(task.id);
  const setTaskTags = useSetTaskTags();
  const createTag = useCreateTag();
  const [newTag, setNewTag] = useState("");
  const [adding, setAdding] = useState(false);
  const selectedIds = new Set(selected.map((tag) => tag.id));

  const toggle = (tag: Tag) => {
    const next = new Set(selectedIds);
    if (next.has(tag.id)) next.delete(tag.id);
    else next.add(tag.id);
    setTaskTags.mutate({ taskId: task.id, tagIds: [...next] });
  };

  const submitNew = async () => {
    const name = newTag.trim();
    if (!name) return;
    try {
      const tag = await createTag.mutateAsync({ name });
      await setTaskTags.mutateAsync({
        taskId: task.id,
        tagIds: [...selectedIds, tag.id],
      });
      setNewTag("");
      setAdding(false);
    } catch {
      // Toast is handled by the mutation.
    }
  };

  return (
    <section className="mt-7" aria-labelledby="task-tags-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="task-tags-heading" className="label-caps flex items-center gap-1.5">
          <Tags className="h-3.5 w-3.5" aria-hidden="true" />
          Tags
        </h3>
        <button
          type="button"
          className="btn btn-ghost min-h-9 px-2 text-12"
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {adding ? "Close" : "New tag"}
        </button>
      </div>
      {allTags.length === 0 && !adding ? (
        <p className="text-13 text-muted">No tags yet. Add one to group tasks.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => (
            <Chip
              key={tag.id}
              tag={tag}
              selected={selectedIds.has(tag.id)}
              onClick={() => toggle(tag)}
            />
          ))}
        </div>
      )}
      {adding ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNew();
          }}
        >
          <input
            className="input min-h-10 flex-1"
            value={newTag}
            maxLength={80}
            placeholder="Tag name"
            onChange={(event) => setNewTag(event.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={createTag.isPending || setTaskTags.isPending || !newTag.trim()}
          >
            Add
          </button>
        </form>
      ) : null}
    </section>
  );
}

export function SubtaskSection({ task }: { task: Task }) {
  const query = useSubtasks(task.id);
  const { create, update, remove } = useSubtaskMutations(task.id);
  const [title, setTitle] = useState("");
  const subtasks = query.data ?? [];
  const done = subtasks.filter((subtask) => subtask.done).length;

  const submit = async () => {
    const value = title.trim();
    if (!value) return;
    try {
      await create.mutateAsync(value);
      setTitle("");
    } catch {
      // Handled by toast.
    }
  };

  return (
    <section className="mt-7" aria-labelledby="task-subtasks-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="task-subtasks-heading" className="label-caps">
          Subtasks
        </h3>
        {subtasks.length > 0 ? (
          <span className="mono text-11 text-faint">
            {done}/{subtasks.length}
          </span>
        ) : null}
      </div>
      {subtasks.length > 0 ? (
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-hairline">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${subtasks.length ? (done / subtasks.length) * 100 : 0}%` }}
          />
        </div>
      ) : null}
      <ul className="space-y-0.5">
        {subtasks.map((subtask: Subtask) => (
          <li
            key={subtask.id}
            className="group flex min-h-10 items-center gap-2 rounded-sm px-1 hover:bg-selection/50"
          >
            <button
              type="button"
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                subtask.done
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-hairline-strong text-transparent",
              )}
              aria-label={subtask.done ? `Reopen ${subtask.title}` : `Complete ${subtask.title}`}
              aria-pressed={subtask.done}
              onClick={() =>
                update.mutate({
                  subtask,
                  patch: { done: !subtask.done },
                })
              }
            >
              <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
            </button>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-13",
                subtask.done ? "text-faint line-through" : "text-ink-soft",
              )}
            >
              {subtask.title}
            </span>
            <button
              type="button"
              className="icon-btn h-8 w-8 text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Delete ${subtask.title}`}
              onClick={() => remove.mutate(subtask)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="input min-h-10 flex-1"
          value={title}
          maxLength={500}
          placeholder="Add a subtask"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={create.isPending || !title.trim()}
        >
          Add
        </button>
      </form>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentSection({ task }: { task: Task }) {
  const query = useAttachments(task.id);
  const { upload, remove } = useAttachmentMutations(task.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const attachments = query.data ?? [];

  return (
    <section className="mt-7" aria-labelledby="task-attachments-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="task-attachments-heading" className="label-caps flex items-center gap-1.5">
          <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
          Attachments
        </h3>
        <button
          type="button"
          className="btn btn-ghost min-h-9 px-2 text-12"
          onClick={() => inputRef.current?.click()}
          disabled={upload.isPending || attachments.length >= 20}
          aria-busy={upload.isPending}
        >
          <Upload className="h-3.5 w-3.5" />
          {upload.isPending ? "Uploading…" : "Add file"}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = "";
          }}
        />
      </div>
      {attachments.length === 0 ? (
        <p className="text-13 text-muted">No files attached.</p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-hairline">
          {attachments.map((attachment: Attachment) => (
            <li
              key={attachment.id}
              className="group flex min-h-11 items-center gap-2 border-b border-hairline bg-canvas px-2.5 py-1.5 last:border-b-0"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <a
                href={attachment.url}
                className="min-w-0 flex-1 truncate text-13 text-ink-soft underline-offset-2 hover:underline"
                download={attachment.filename}
              >
                {attachment.filename}
              </a>
              <span className="mono shrink-0 text-11 text-faint">
                {formatBytes(attachment.bytes)}
              </span>
              <a
                href={attachment.url}
                className="icon-btn h-8 w-8 text-faint"
                aria-label={`Download ${attachment.filename}`}
                download={attachment.filename}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                className="icon-btn h-8 w-8 text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Delete ${attachment.filename}`}
                onClick={() => remove.mutate(attachment)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
