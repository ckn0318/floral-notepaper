import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeOption } from "./types";

/** Per-window light/dark override, keyed by window label so each window (notepad,
 *  todo) themes itself independently of the shared config and of other windows.
 *  localStorage is shared across same-origin windows, so the label keeps them
 *  separate. */
function windowThemeKey(): string | null {
  try {
    return `floral-theme:${getCurrentWindow().label}`;
  } catch {
    return null; // not in a Tauri environment (tests)
  }
}

export function loadWindowTheme(): "light" | "dark" | null {
  const key = windowThemeKey();
  if (!key) return null;
  const value = localStorage.getItem(key);
  return value === "light" || value === "dark" ? value : null;
}

export function saveWindowTheme(theme: "light" | "dark"): void {
  const key = windowThemeKey();
  if (key) localStorage.setItem(key, theme);
}

function resolveTheme(option: ThemeOption): "light" | "dark" {
  if (option === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return option;
}

export function applyTheme(option: ThemeOption): void {
  const root = document.documentElement;
  const resolved = resolveTheme(option);
  if (root.getAttribute("data-theme") !== resolved) {
    root.classList.add("theme-transition");
    root.setAttribute("data-theme", resolved);
    setTimeout(() => root.classList.remove("theme-transition"), 400);
  }
}

let systemListener: (() => void) | null = null;

export function watchSystemTheme(option: ThemeOption): () => void {
  if (systemListener) {
    systemListener();
    systemListener = null;
  }

  if (option !== "system") return () => {};

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => applyTheme("system");
  mql.addEventListener("change", handler);

  const cleanup = () => {
    mql.removeEventListener("change", handler);
    systemListener = null;
  };
  systemListener = cleanup;
  return cleanup;
}
