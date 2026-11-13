import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Task, TaskList } from "@/api";
import { cn } from "@/lib/utils";
import { TaskRow } from "./TaskRow";

export function TaskGroup({
  title,
  tasks,
  lists,
  showList = false,
  tone = "default",
  variant = "section",
  count,
}: {
  title: ReactNode;
  tasks: Task[];
  lists: TaskList[];
  showList?: boolean;
  tone?: "default" | "overdue" | "muted";
  variant?: "section" | "day";
  count?: number;
}) {
  const headingId = useId();
  if (tasks.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-6 first:mt-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2
          id={headingId}
          className={cn(
            variant === "day" ? "serif text-17 text-ink" : "label-caps",
            tone === "overdue" && "text-danger",
            tone === "muted" && "text-muted",
          )}
        >
          {title}
        </h2>
        <span
          className={cn(
            "text-12 tabular-nums",
            tone === "overdue" ? "text-danger/80" : "text-faint",
          )}
        >
          {count ?? tasks.length}
        </span>
      </div>
      <div className="border-t border-hairline">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            lists={lists}
            showList={showList}
          />
        ))}
      </div>
    </section>
  );
}

export function CompletedGroup({
  tasks,
  lists,
  showList = false,
}: {
  tasks: Task[];
  lists: TaskList[];
  showList?: boolean;
}) {
  if (tasks.length === 0) return null;

  return (
    <details className="group mt-8">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-13 font-medium text-muted [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="h-4 w-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        Completed
        <span className="text-12 tabular-nums text-faint">{tasks.length}</span>
      </summary>
      <div className="mt-1 border-t border-hairline">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            lists={lists}
            showList={showList}
          />
        ))}
      </div>
    </details>
  );
}
