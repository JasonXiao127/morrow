import { createContext, useContext } from "react";

export interface ShellActions {
  openCapture: (
    listId?: string | null,
    seed?: { date?: string; title?: string },
  ) => void;
  openAssistant: (prompt?: string) => void;
  /** One-shot prompt set by the command palette; the assistant consumes it. */
  assistantPrompt: string | null;
  consumeAssistantPrompt: () => void;
  openPalette: () => void;
  selectTask: (taskId: string) => void;
  closeInspector: () => void;
  selectedTaskId: string | null;
}

const ShellContext = createContext<ShellActions | null>(null);

export const ShellActionsProvider = ShellContext.Provider;

export function useShell(): ShellActions {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside the app shell");
  return value;
}
