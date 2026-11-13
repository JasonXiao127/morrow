// Runs synchronously before the app renders to avoid a light flash in dark mode.
// Kept as a separate file so the strict CSP can use script-src 'self'.
(function () {
  try {
    var stored = localStorage.getItem("morrow.theme");
    var dark =
      stored === "dark" ||
      ((!stored || stored === "system") &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", Boolean(dark));
  } catch (error) {
    // Storage or matchMedia may be unavailable in hardened browsers.
  }
})();
