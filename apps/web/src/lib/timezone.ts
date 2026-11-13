export function detectedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function timezoneList(): string[] {
  const current = detectedTimezone();
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported?.length) {
      return supported.includes(current) ? supported : [current, ...supported];
    }
  } catch {
    // Fall through to the small list.
  }
  return Array.from(
    new Set([current, "UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"]),
  );
}

export function localTimeFor(zone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());
  } catch {
    return "—";
  }
}
