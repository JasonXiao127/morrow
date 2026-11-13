/** Cross-component task field focus (D = date, R = repeat). */
export const TASK_FIELD_EVENT = "morrow:task-field";

export type TaskFocusField = "date" | "repeat" | "title";

export interface TaskFieldFocusDetail {
  taskId: string;
  field: TaskFocusField;
}

export function focusTaskField(taskId: string, field: TaskFocusField): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TaskFieldFocusDetail>(TASK_FIELD_EVENT, {
      detail: { taskId, field },
    }),
  );
}
