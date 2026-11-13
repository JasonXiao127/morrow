// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AssistantConversation,
  AssistantStatus,
} from "@/api";
import { AssistantPanel } from "@/components/AssistantPanel";
import {
  ShellActionsProvider,
  type ShellActions,
} from "@/components/shell-context";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  messages: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  streamAssistant: vi.fn(),
}));

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    assistantApi: {
      ...actual.assistantApi,
      status: api.status,
      listConversations: api.listConversations,
      createConversation: api.createConversation,
      messages: api.messages,
      send: api.send,
      stop: api.stop,
    },
    streamAssistant: api.streamAssistant,
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
  }: {
    children?: ReactNode;
    to?: string;
  }) => <a href={typeof to === "string" ? to : "#"}>{children}</a>,
}));

const readyStatus: AssistantStatus = {
  enabled: true,
  available: true,
  connected: true,
  status: "ready",
  model: "test/model",
  message: null,
};

const conversation: AssistantConversation = {
  id: "conv-existing",
  opencodeSessionId: "session-1",
  title: "Morrow assistant",
  status: "active",
  lastMessageAt: null,
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  lastError: null,
};

const shell: ShellActions = {
  openCapture: vi.fn(),
  openAssistant: vi.fn(),
  assistantPrompt: null,
  consumeAssistantPrompt: vi.fn(),
  openPalette: vi.fn(),
  selectTask: vi.fn(),
  closeInspector: vi.fn(),
  selectedTaskId: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushStateUpdates() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPanel(options: { strict?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = (
    <QueryClientProvider client={client}>
      <ShellActionsProvider value={shell}>
        <AssistantPanel />
      </ShellActionsProvider>
    </QueryClientProvider>
  );
  return render(options.strict ? <StrictMode>{panel}</StrictMode> : panel);
}

beforeEach(() => {
  window.localStorage.clear();
  api.status.mockResolvedValue({ status: readyStatus });
  api.listConversations.mockResolvedValue({ conversations: [conversation] });
  api.createConversation.mockResolvedValue({
    conversation: { ...conversation, id: "conv-new" },
  });
  api.messages.mockImplementation(async (id: string) => ({
    conversation: { ...conversation, id },
    messages: [],
    proposals: [],
    running: false,
    lastError: null,
  }));
  api.send.mockResolvedValue({
    message: {
      id: "msg-1",
      conversationId: conversation.id,
      role: "user",
      content: "hello",
      opencodeMessageId: null,
      createdAt: "2026-11-13T00:00:00.000Z",
    },
    runId: "run-1",
    status: readyStatus,
  });
  api.stop.mockResolvedValue({ stopped: true });
  // A real stream stays open until the panel unmounts; keep it pending here.
  api.streamAssistant.mockImplementation(
    () => new Promise<void>(() => {}),
  );
});

afterEach(() => {
  cleanup();
});

describe("AssistantPanel conversation bootstrap", () => {
  it("selects an existing conversation and enables the composer", async () => {
    // Hold the response until the effect has re-rendered. A resolved mock
    // can win the race and hide the self-cancelling dependency regression.
    const listed = deferred<{ conversations: AssistantConversation[] }>();
    api.listConversations.mockReturnValue(listed.promise);

    renderPanel();
    await waitFor(() => expect(api.listConversations).toHaveBeenCalled());
    await flushStateUpdates();
    listed.resolve({ conversations: [conversation] });

    const composer = await screen.findByPlaceholderText(
      /Ask Morrow to plan, triage, or change one thing/,
    );

    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("morrow.assistant.conversation")).toBe(
      "conv-existing",
    );
  });

  it("creates a conversation when the list is empty", async () => {
    const listed = deferred<{ conversations: AssistantConversation[] }>();
    api.listConversations.mockReturnValue(listed.promise);

    renderPanel();
    await waitFor(() => expect(api.listConversations).toHaveBeenCalled());
    await flushStateUpdates();
    listed.resolve({ conversations: [] });

    const composer = await screen.findByPlaceholderText(
      /Ask Morrow to plan, triage, or change one thing/,
    );

    expect(api.createConversation).toHaveBeenCalledWith("Morrow assistant");
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(window.localStorage.getItem("morrow.assistant.conversation")).toBe(
      "conv-new",
    );
  });

  it("does not strand the panel under StrictMode", async () => {
    const listed = deferred<{ conversations: AssistantConversation[] }>();
    api.listConversations.mockReturnValue(listed.promise);

    renderPanel({ strict: true });
    await waitFor(() => expect(api.listConversations).toHaveBeenCalled());
    await flushStateUpdates();
    listed.resolve({ conversations: [conversation] });

    const composer = await screen.findByPlaceholderText(
      /Ask Morrow to plan, triage, or change one thing/,
    );

    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("shows a retry and recovers when bootstrap fails", async () => {
    const failed = deferred<{ conversations: AssistantConversation[] }>();
    api.listConversations.mockReturnValue(failed.promise);

    renderPanel();
    await waitFor(() => expect(api.listConversations).toHaveBeenCalled());
    await flushStateUpdates();
    failed.reject(new Error("Sidecar unavailable"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The assistant could not start.");
    expect(alert.textContent).toContain("Sidecar unavailable");

    api.listConversations.mockResolvedValue({ conversations: [conversation] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const composer = await screen.findByPlaceholderText(
      /Ask Morrow to plan, triage, or change one thing/,
    );
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });
});
