import type { Config } from "tailwindcss";

/**
 * Tailwind v4 is configured primarily in `src/index.css` (@theme / @theme inline).
 * This file exists for tooling that expects a Tailwind config and to pin the
 * dark-mode strategy and content roots.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
} satisfies Config;
