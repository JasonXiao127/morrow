import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn("h-8 w-8", className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="11"
        className="fill-surface stroke-hairline"
        strokeWidth="1"
      />
      <circle cx="20" cy="16.5" r="6.2" className="fill-accent" />
      <path
        d="M9.5 24.5h21"
        className="stroke-hairline"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M13 29h14"
        className="stroke-ink"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
