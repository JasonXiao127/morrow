import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  Inbox,
  ListChecks,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Sun,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiErrorMessage,
  assistantApi,
  streamAssistant,
  type AssistantEvent,
  type AssistantMessage,
  type ConversationLastError,
  type Proposal,
} from "@/api";
import {
  canChat,
  statusLabel,
  useAssistantStatus,
  useUndoBatch,
} from "@/lib/assistant";
import { invalidateTaskQueries } from "@/lib/query";
import {
  parseToolActivityContent,
  toolActivityLabel,
} from "@/lib/tool-activity";
import { useShell } from "./shell-context";
import { Markdown } from "./Markdown";
import { ProposalCard } from "./ProposalCard";

const INTRO = `I can read your lists, propose a plan, and make **single changes** with undo.  
Bulk edits, deletes, and recurrence changes always wait for your approval.`;

const SUGGESTIONS = [
  {
    label: "Plan my day",
    prompt: "Plan my day. Look at overdue, today, and unscheduled tasks. Propose a small plan; do not change anything yet.",
    icon: <Sun className="h-4 w-4" aria-hidden="true" />,
  },
  {
    label: "What’s overdue?",
    prompt: "What is overdue? Summarize the tasks and suggest the smallest useful next step.",
    icon: <ListChecks className="h-4 w-4" aria-hidden="true" />,
  },
  {
    label: "Triage my inbox",
    prompt: "Triage my inbox. Suggest a few concrete changes as a proposal; nothing should change until I approve.",
    icon: <Inbox className="h-4 w-4" aria-hidden="true" />,
  },
];

const STORAGE_KEY = "morrow.assistant.conversation";

function readStoredConversation(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeConversation(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode; session state still works
  }
}

function upsertMessage(
  messages: AssistantMessage[],
  next: AssistantMessage,
): AssistantMessage[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index < 0) return [...messages, next];
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function AssistantPanel({ onClose }: { onClose?: () => void }) {
  const { assistantPrompt, consumeAssistantPrompt } = useShell();
  const queryClient = useQueryClient();
  const statusQuery = useAssistantStatus();
  const status = statusQuery.data?.status;
  const ready = canChat(status);
  const undoBatch = useUndoBatch();
  const undoBatchRef = useRef(undoBatch);

  const [conversationId, setConversationId] = useState<string | null>(() =>
    readStoredConversation(),
  );
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [toolName, setToolName] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<ConversationLastError | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [creatingNew, setCreatingNew] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bootstrapRef = useRef<Promise<string> | null>(null);
  const lastEventId = useRef<number | null>(null);

  const dismissKey = conversationId
    ? `morrow.assistant.lastErrorDismissed.${conversationId}`
    : null;

  const dismissLastError = useCallback(() => {
    if (!conversationId || !lastError) return;
    try {
      window.localStorage.setItem(dismissKey ?? "", lastError.at);
    } catch {
      // private mode; hide for this session only
    }
    setLastError(null);
  }, [conversationId, dismissKey, lastError]);

  useEffect(() => {
    undoBatchRef.current = undoBatch;
  }, [undoBatch]);

  useEffect(() => {
    lastEventId.current = null;
  }, [conversationId]);

  const refreshConversation = useCallback(async () => {
    if (!conversationId) return;
    try {
      const data = await assistantApi.messages(conversationId);
      setMessages(data.messages);
      setProposals(data.proposals);
      setRunning(data.running);
      setStreamError(null);
      const error =
        data.lastError ?? data.conversation.lastError ?? null;
      if (error) {
        let dismissed: string | null = null;
        try {
          dismissed = window.localStorage.getItem(
            `morrow.assistant.lastErrorDismissed.${conversationId}`,
          );
        } catch {
          dismissed = null;
        }
        setLastError(dismissed === error.at ? null : error);
      } else {
        setLastError(null);
      }
    } catch (error) {
      // A stale local id should not strand the panel.
      if (conversationId === readStoredConversation()) {
        storeConversation(null);
        setConversationId(null);
        setMessages([]);
        setProposals([]);
      }
      void error;
    }
  }, [conversationId]);

  // Pick or create one interactive conversation. Offline/off still shows any
  // stored transcript, but never creates a session that cannot be used.
  useEffect(() => {
    if (conversationId || !ready) return;
    let active = true;
    setBootstrapError(null);

    // Keep one in-flight bootstrap across React StrictMode's mount/unmount
    // cycle. The request must not be cancelled just because this effect ran
    // again: doing so strands the panel on "Preparing the assistant…".
    if (!bootstrapRef.current) {
      bootstrapRef.current = (async () => {
        try {
          const listed = await assistantApi.listConversations();
          const existing = listed.conversations[0]?.id ?? null;
          if (existing) return existing;
          const created = await assistantApi.createConversation(
            "Morrow assistant",
          );
          return created.conversation.id;
        } finally {
          bootstrapRef.current = null;
        }
      })();
    }

    void bootstrapRef.current
      .then((id) => {
        if (!active) return;
        setConversationId(id);
        storeConversation(id);
      })
      .catch((error) => {
        if (!active) return;
        setBootstrapError(apiErrorMessage(error));
      });

    return () => {
      active = false;
    };
  }, [conversationId, ready, bootstrapNonce]);

  useEffect(() => {
    if (!conversationId) return;
    void refreshConversation();
  }, [conversationId, refreshConversation]);

  const handleEvent = useCallback(
    (event: AssistantEvent) => {
      const data = event.data;
      if (event.type === "assistant.snapshot") {
        const snapshotMessages = Array.isArray(data["messages"])
          ? (data["messages"] as AssistantMessage[])
          : [];
        const snapshotProposals = Array.isArray(data["proposals"])
          ? (data["proposals"] as Proposal[])
          : [];
        setMessages(snapshotMessages);
        setProposals(snapshotProposals);
        setRunning(Boolean(data["running"]));
        setDraft("");
        setToolName(null);
        setStreamError(null);
        return;
      }
      if (event.type === "assistant.message") {
        const message = data["message"] as AssistantMessage | undefined;
        if (message) setMessages((current) => upsertMessage(current, message));
        return;
      }
      if (event.type === "assistant.delta") {
        const delta = typeof data["delta"] === "string" ? data["delta"] : "";
        if (delta) setDraft((current) => `${current}${delta}`);
        setRunning(true);
        return;
      }
      if (event.type === "assistant.text") {
        const text = typeof data["text"] === "string" ? data["text"] : "";
        setDraft(text);
        return;
      }
      if (event.type === "assistant.run.started") {
        setRunning(true);
        setDraft("");
        setToolName(null);
        return;
      }
      if (event.type === "assistant.tool.started") {
        setToolName(
          typeof data["tool"] === "string" ? data["tool"] : "reminders_tool",
        );
        return;
      }
      if (event.type === "assistant.tool.finished") {
        setToolName(null);
        return;
      }
      if (
        event.type === "assistant.run.completed" ||
        event.type === "assistant.run.failed" ||
        event.type === "assistant.run.stopped"
      ) {
        setRunning(false);
        setDraft("");
        setToolName(null);
        if (event.type === "assistant.run.failed") {
          const message =
            typeof data["message"] === "string"
              ? data["message"]
              : "The assistant stopped.";
          toast.error(message);
          // Show the banner immediately; the refresh below replaces it with
          // the persisted server copy (which survives reload).
          const code =
            typeof data["code"] === "string" ? data["code"] : null;
          setLastError({ code, message, at: new Date().toISOString() });
        }
        if (event.type === "assistant.run.completed") {
          setLastError(null);
        }
        window.setTimeout(() => void refreshConversation(), 400);
        return;
      }
      if (event.type === "assistant.resync" || event.type === "assistant.reconnected") {
        window.setTimeout(() => void refreshConversation(), 250);
        return;
      }
      if (event.type === "proposal.created" || event.type === "proposal.updated") {
        window.setTimeout(() => void refreshConversation(), 250);
        return;
      }
      if (event.type === "assistant.activity") {
        const batchId =
          typeof data["batchId"] === "string" ? data["batchId"] : null;
        const summary =
          typeof data["summary"] === "string" ? data["summary"] : "Assistant change";
        if (batchId && data["undoable"] === true) {
          toast(summary, {
            description: "This was a single-item write. Undo is available.",
            action: {
              label: "Undo",
              onClick: () => undoBatchRef.current.mutate(batchId),
            },
          });
        }
        void invalidateTaskQueries(queryClient);
        window.setTimeout(() => void refreshConversation(), 250);
      }
    },
    [queryClient, refreshConversation],
  );

  // One OpenCode subscription in the app fans out to this fetch stream.
  // Reconnect with Last-Event-ID; the server replays its ring + transcript.
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    let stopped = false;
    let attempt = 0;
    const connect = async () => {
      while (!stopped) {
        try {
          await streamAssistant(conversationId, {
            lastEventId: lastEventId.current,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.id > 0) lastEventId.current = event.id;
              handleEvent(event);
            },
          });
          if (stopped) return;
        } catch (error) {
          if (stopped) return;
          setStreamError("Reconnecting to the assistant…");
          void error;
        }
        attempt += 1;
        await sleep(Math.min(8_000, 800 * 2 ** Math.min(4, attempt)));
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [conversationId, handleEvent]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [draft, messages, proposals, running, toolName]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !conversationId) return;
      if (!ready) {
        toast.error("The assistant is off", {
          description: "Morrow works fully without it. Add a model in Settings → AI.",
        });
        return;
      }
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        toast.error("You’re offline", {
          description: "The assistant needs a connection. Your tasks are unchanged.",
        });
        return;
      }
      const temp: AssistantMessage = {
        id: `local-${Date.now()}`,
        conversationId,
        role: "user",
        content,
        opencodeMessageId: null,
        createdAt: new Date().toISOString(),
      };
      setInput("");
      setSending(true);
      setDraft("");
      setRunning(true);
      setMessages((current) => [...current, temp]);
      try {
        const response = await assistantApi.send(conversationId, content);
        setMessages((current) => [
          ...current.filter(
            (message) =>
              message.id !== temp.id && message.id !== response.message.id,
          ),
          response.message,
        ]);
      } catch (error) {
        setMessages((current) => current.filter((message) => message.id !== temp.id));
        setRunning(false);
        toast.error(apiErrorMessage(error));
      } finally {
        setSending(false);
      }
    },
    [conversationId, ready],
  );

  useEffect(() => {
    if (!assistantPrompt) return;
    if (!ready || !conversationId) return;
    const prompt = assistantPrompt;
    consumeAssistantPrompt();
    void send(prompt);
  }, [assistantPrompt, consumeAssistantPrompt, conversationId, ready, send]);

  const stop = async () => {
    if (!conversationId) return;
    try {
      await assistantApi.stop(conversationId);
      setRunning(false);
      setDraft("");
      setToolName(null);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  };

  const retryStatus = () => {
    void statusQuery.refetch();
  };

  const retryBootstrap = () => {
    bootstrapRef.current = null;
    setBootstrapError(null);
    setBootstrapNonce((value) => value + 1);
  };

  const startNewConversation = async () => {
    if (creatingNew) return;
    setCreatingNew(true);
    try {
      // A fresh OpenCode session is created with the currently selected model.
      // This is also how a fallback model takes effect for an existing chat.
      const created = await assistantApi.createConversation("Morrow assistant");
      setConversationId(created.conversation.id);
      storeConversation(created.conversation.id);
      setMessages([]);
      setProposals([]);
      setDraft("");
      setLastError(null);
      setBootstrapError(null);
      setStreamError(null);
      setToolName(null);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setCreatingNew(false);
    }
  };

  const preparing = ready && !conversationId && !bootstrapError;
  const disabled = !ready || !conversationId || sending || running;
  const agentLabel = statusLabel(status);
  const showSetup =
    status &&
    (status.status === "not_configured" ||
      status.status === "model_missing" ||
      status.status === "model_not_tool_capable" ||
      status.status === "unreachable" ||
      status.status === "contract_mismatch" ||
      status.status === "disabled");

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="text-13 font-semibold text-ink">Assistant</h2>
        <span
          className={
            ready
              ? "rounded-sm border border-hairline px-1.5 py-0.5 text-12 text-success"
              : "rounded-sm border border-hairline px-1.5 py-0.5 text-12 text-muted"
          }
        >
          {agentLabel}
        </span>
        <button
          type="button"
          className="icon-btn ml-auto"
          onClick={() => void startNewConversation()}
          aria-label="New conversation"
          title="New conversation"
          disabled={!ready || creatingNew}
          aria-busy={creatingNew}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
        {onClose ? (
          <button
            type="button"
            className="icon-btn -mr-2"
            onClick={onClose}
            aria-label="Close assistant"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5"
        aria-live="polite"
      >
        {lastError ? (
          <div
            className="mb-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5"
            role="alert"
          >
            <div className="min-w-0 flex-1">
              <p className="text-13 font-semibold text-ink">
                Last run: {lastError.message}
              </p>
              {lastError.code ? (
                <p className="mono mt-0.5 text-12 text-muted">{lastError.code}</p>
              ) : null}
              <Link
                to="/settings"
                search={{ section: "ai" }}
                className="mt-1 inline-block text-12 font-semibold text-accent underline underline-offset-2"
              >
                Model settings
              </Link>
            </div>
            <button
              type="button"
              className="icon-btn -mr-1 -mt-1 shrink-0"
              onClick={dismissLastError}
              aria-label="Dismiss last run error"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {bootstrapError && ready && !conversationId ? (
          <div
            className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5"
            role="alert"
          >
            <p className="text-13 font-semibold text-ink">
              The assistant could not start.
            </p>
            <p className="mt-1 break-words text-12 text-muted">
              {bootstrapError}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary min-h-11 px-3 text-12"
                onClick={retryBootstrap}
              >
                Try again
              </button>
              <Link
                to="/settings"
                search={{ section: "ai" }}
                className="text-12 font-semibold text-accent underline underline-offset-2"
              >
                Settings → AI
              </Link>
            </div>
          </div>
        ) : null}
        {messages.length === 0 && !draft ? (
          <>
            <p className="serif text-22 leading-tight text-ink">
              A second pair of eyes.
            </p>
            <Markdown className="mt-3 text-13 leading-relaxed">{INTRO}</Markdown>
            <div className="mt-5 space-y-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  onClick={() => void send(suggestion.prompt)}
                  disabled={disabled}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-md border border-hairline bg-canvas px-3 text-left text-13 text-ink-soft transition-colors hover:border-hairline-strong hover:bg-selection disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="text-accent">{suggestion.icon}</span>
                  <span>{suggestion.label}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => {
              const activity =
                message.role === "system"
                  ? parseToolActivityContent(message.content)
                  : null;
              if (activity) {
                return (
                  <div
                    key={message.id}
                    className="flex max-w-[96%] items-center gap-2 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-12 text-muted"
                  >
                    {activity.ok ? (
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <X
                        className="h-3.5 w-3.5 shrink-0 text-danger"
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-ink-soft">
                      {toolActivityLabel(activity.tool)}
                    </span>
                    <span className="ml-auto">
                      {activity.ok ? "done" : "failed"}
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-auto max-w-[92%] rounded-lg border border-hairline bg-accent-soft px-3 py-2.5 text-13 text-ink"
                      : "max-w-[96%] text-13 text-ink"
                  }
                >
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {message.content}
                    </p>
                  ) : (
                    <Markdown className="leading-relaxed">
                      {message.content}
                    </Markdown>
                  )}
                </div>
              );
            })}
            {draft ? (
              <div className="max-w-[96%] text-13 text-ink">
                <Markdown className="leading-relaxed">{draft}</Markdown>
              </div>
            ) : null}
            {running || toolName ? (
              <p className="flex items-center gap-2 text-12 text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {toolName ? `Using ${toolName}…` : "Thinking…"}
              </p>
            ) : null}
          </div>
        )}

        {proposals.length > 0 ? (
          <div className="mt-5 space-y-3">
            {proposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </div>
        ) : null}

        {showSetup ? (
          <div className="mt-5 rounded-md border border-hairline bg-canvas p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="label-caps">Assistant status</span>
              <span className="text-12 text-faint">{agentLabel}</span>
            </div>
            <p className="mt-2 text-13 leading-relaxed text-muted">
              {status?.status === "model_missing" ||
              status?.status === "model_not_tool_capable"
                ? "Choose a tool-capable model in Settings → AI. Morrow’s reminders work without it."
                : status?.status === "contract_mismatch"
                  ? "The OpenCode sidecar version does not match this app build. Update the image or the client pin."
                  : "The assistant is optional. Your lists, recurrence, reminders, push, and backups keep working with AI off."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to="/settings"
                search={{ section: "ai" }}
                className="btn btn-secondary min-h-11 px-3 text-12"
              >
                Settings → AI
              </Link>
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-3 text-12"
                onClick={retryStatus}
              >
                Check again
              </button>
            </div>
          </div>
        ) : null}

        {streamError ? (
          <p className="mt-4 text-12 text-muted" role="status">
            {streamError}
          </p>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-hairline p-3">
        <div className="input-shell flex items-end gap-2 rounded-md border border-hairline bg-canvas p-2">
          <textarea
            className="max-h-24 min-h-11 flex-1 resize-none bg-transparent px-1 py-1.5 text-13 text-ink outline-none placeholder:text-faint disabled:opacity-60"
            placeholder={
              !ready
                ? "Assistant is off. Morrow works without it."
                : preparing
                  ? "Preparing the assistant…"
                  : bootstrapError && !conversationId
                    ? "The assistant could not start. Try again above."
                    : "Ask Morrow to plan, triage, or change one thing…"
            }
            rows={2}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!disabled) void send(input);
              }
            }}
            disabled={disabled}
            aria-label="Ask the assistant"
          />
          {running ? (
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink"
              aria-label="Stop the assistant"
              onClick={() => void stop()}
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink disabled:opacity-50"
              aria-label="Send to assistant"
              disabled={disabled || !input.trim()}
              onClick={() => void send(input)}
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 flex items-center justify-between gap-2 px-1 text-12 text-faint">
          <span className="flex items-center gap-1.5">
            <span
              className={
                ready
                  ? "h-1.5 w-1.5 rounded-full bg-success"
                  : "h-1.5 w-1.5 rounded-full bg-faint"
              }
              aria-hidden="true"
            />
            {agentLabel}
          </span>
          <span>Assistant can propose; you approve.</span>
        </p>
      </div>
    </div>
  );
}

