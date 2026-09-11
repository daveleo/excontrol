import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "excontrol-theme";

function getStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Top-right dark/light switch. Until the operator picks one, the page follows the OS
 *  theme (no explicit choice is stamped) — same as before this existed. Once toggled, the
 *  choice is remembered per-browser (localStorage) and overrides the OS setting. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(() => getStored());

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private browsing, etc. */ }
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme]);

  const effective = theme ?? (systemPrefersDark() ? "dark" : "light");

  return (
    <button
      className="icon-btn theme-toggle"
      title={effective === "dark" ? "Switch to bright mode" : "Switch to dark mode"}
      aria-label="Toggle dark / bright mode"
      onClick={() => setTheme(effective === "dark" ? "light" : "dark")}
    >
      {effective === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path
        strokeLinecap="round"
        d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}
