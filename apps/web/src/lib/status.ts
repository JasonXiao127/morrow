export type StatusTone = "success" | "warning" | "danger" | "muted";

export function statusToneForPermission(
  permission: NotificationPermission | "unsupported",
): StatusTone {
  if (permission === "granted") return "success";
  if (permission === "denied") return "danger";
  if (permission === "unsupported") return "muted";
  return "warning";
}
