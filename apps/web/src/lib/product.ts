import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  apiErrorMessage,
  attachmentApi,
  authApi,
  backupApi,
  captureTokenApi,
  subtaskApi,
  tagApi,
  type Attachment,
  type CaptureToken,
  type CaptureTokenKind,
  type Subtask,
  type Tag,
  type Task,
} from "@/api";
import { announce } from "./announce";
import { bootstrapQueryOptions, invalidateBootstrap, queryKeys } from "./query";
import { useAppData } from "./queries";

export function useTags(): Tag[] {
  const { bootstrap } = useAppData();
  return bootstrap?.tags ?? [];
}

export function tagsForTask(
  bootstrap: ReturnType<typeof useAppData>["bootstrap"],
  taskId: string,
): Tag[] {
  if (!bootstrap?.tags || !bootstrap.taskTags) return [];
  const byId = new Map(bootstrap.tags.map((tag) => [tag.id, tag]));
  return bootstrap.taskTags
    .filter((entry) => entry.taskId === taskId)
    .map((entry) => byId.get(entry.tagId))
    .filter((tag): tag is Tag => Boolean(tag));
}

export function useTaskTags(taskId: string | null): Tag[] {
  const { bootstrap } = useAppData();
  return taskId ? tagsForTask(bootstrap, taskId) : [];
}

export function useCreateTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; color?: string | null }) =>
      tagApi.create(input),
    onSuccess: async (tag) => {
      await invalidateBootstrap(queryClient);
      announce(`Created tag ${tag.name}.`);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useUpdateTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tag, patch }: { tag: Tag; patch: { name?: string; color?: string | null } }) =>
      tagApi.update(tag, patch),
    onSuccess: async () => {
      await invalidateBootstrap(queryClient);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useDeleteTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tag: Tag) => tagApi.remove(tag),
    onSuccess: async () => {
      await invalidateBootstrap(queryClient);
      toast.success("Tag removed.");
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useSetTaskTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, tagIds }: { taskId: string; tagIds: string[] }) =>
      tagApi.setForTask(taskId, tagIds),
    onSuccess: async () => {
      await invalidateBootstrap(queryClient);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useSubtasks(taskId: string | null) {
  return useQuery({
    queryKey: ["subtasks", taskId ?? "__none__"],
    queryFn: () => subtaskApi.list(taskId as string),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
}

export function useSubtaskMutations(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["subtasks", taskId ?? "__none__"] });
    await invalidateBootstrap(queryClient);
  };
  const create = useMutation({
    mutationFn: (title: string) =>
      subtaskApi.create(taskId as string, { title }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const update = useMutation({
    mutationFn: ({ subtask, patch }: { subtask: Subtask; patch: { title?: string; done?: boolean } }) =>
      subtaskApi.update(subtask, patch),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (subtask: Subtask) => subtaskApi.remove(subtask),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return { create, update, remove, busy: create.isPending || update.isPending || remove.isPending };
}

export function useAttachments(taskId: string | null) {
  return useQuery({
    queryKey: ["attachments", taskId ?? "__none__"],
    queryFn: () => attachmentApi.list(taskId as string),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
}

export function useAttachmentMutations(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["attachments", taskId ?? "__none__"] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => attachmentApi.upload(taskId as string, file),
    onSuccess: async (attachment: Attachment) => {
      await invalidate();
      toast.success("Attachment added.", { description: attachment.filename });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (attachment: Attachment) => attachmentApi.remove(attachment),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return { upload, remove };
}

export function useCaptureTokens() {
  return useQuery({
    queryKey: ["capture-tokens"],
    queryFn: () => captureTokenApi.list(),
    staleTime: 15_000,
  });
}

export function useCaptureTokenMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["capture-tokens"] });
  };
  const create = useMutation({
    mutationFn: ({
      name,
      kind = "capture",
    }: {
      name: string;
      kind?: CaptureTokenKind;
    }) => captureTokenApi.create(name, kind),
    onSuccess: async (token: CaptureToken) => {
      await invalidate();
      announce(
        `Created ${token.kind === "caldav" ? "CalDAV" : "capture"} token ${token.name}.`,
      );
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => captureTokenApi.revoke(id),
    onSuccess: async () => {
      await invalidate();
      toast.success("Capture token revoked.");
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return { create, revoke };
}

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => authApi.sessions(),
    staleTime: 10_000,
  });
}

export function useSessionMutations() {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Session revoked.");
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const changePassword = useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => authApi.changePassword(currentPassword, newPassword),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Password changed.", {
        description:
          result.revokedSessions && result.revokedSessions > 0
            ? `${result.revokedSessions} other session(s) signed out.`
            : "Other sessions were already signed out.",
      });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return { revoke, changePassword };
}

export function useBackupImport() {
  const queryClient = useQueryClient();
  const importBackup = useMutation({
    mutationFn: ({
      file,
      dryRun,
      confirm,
    }: {
      file: File;
      dryRun?: boolean;
      confirm?: string;
    }) => backupApi.import(file, { dryRun, confirm }),
    onSuccess: async (result, variables) => {
      if (!variables.dryRun) {
        await queryClient.invalidateQueries();
        toast.success("Backup restored.", {
          description: "Sign in again on other devices; push re-subscribes on this one.",
        });
      }
      return result;
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return importBackup;
}

/** Convenience for components that only need tag membership on a task. */
export function useTaskTagMembership(task: Task | null): Tag[] {
  return useTaskTags(task?.id ?? null);
}

/** Re-export the base query so a settings panel can refresh defaults. */
export { bootstrapQueryOptions, queryKeys };
