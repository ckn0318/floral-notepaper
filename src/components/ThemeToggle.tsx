import { useState } from "react";
import { applyTheme, loadWindowTheme, saveWindowTheme } from "../features/settings/theme";

/** Per-window dark/light theme toggle. Applies the theme to this window's own
 *  document and persists it under the window-label key, so each window themes
 *  independently of the others and of the shared config. */
export function ThemeToggle({ className, size = 15 }: { className?: string; size?: number }) {
  const [theme, setTheme] = useState<"dark" | "light">(() => loadWindowTheme() ?? "dark");

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    saveWindowTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      onMouseDown={(event) => event.stopPropagation()}
      title={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
      aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
      className={className}
    >
      {theme === "dark" ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}
