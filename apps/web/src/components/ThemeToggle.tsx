import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { Hint } from "./Hint";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  const label = resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Hint label={label}>
      <button
        type="button"
        className={className ?? "icon-btn"}
        onClick={toggle}
        aria-label={label}
      >
        {resolved === "dark" ? (
          <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
        ) : (
          <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
        )}
      </button>
    </Hint>
  );
}
