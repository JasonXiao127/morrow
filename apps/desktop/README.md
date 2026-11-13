# apps/desktop — legacy v0.2 stub (desktop-only thin shell)

This directory is a **scope placeholder, not a build**. v0.3 ships the PWA
only; do not treat this directory as a current release artifact.

Scope when it lands:

- **Desktop only** (Windows/macOS/Linux): a thin shell that loads the same
  server-rendered PWA — tray icon, global capture hotkey, native
  notifications, launch-at-login, `safeStorage` for tokens.
- **No bundled OpenCode.** The assistant sidecar stays server-side; the shell
  never ships it.
- **No mobile.** There is no installable Electron on iOS (and none planned):
  iPhone/iPad is **PWA-only** via Safari → Share → Add to Home Screen
  (iOS 16.4+ for push). Android likewise uses the PWA, not this shell.

Desktop users run the PWA from Chrome/Edge (see `/install` → Desktop).
iOS/Android flows must never reference this directory.
