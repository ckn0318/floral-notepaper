import { invoke } from "@tauri-apps/api/core";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Summons the floating to-do list window. It is a standalone window that
 *  coexists with the notepad — opening it leaves the notepad untouched. */
export function openTodoWindow(bounds?: WindowBounds): Promise<string> {
  return invoke("open_todo_window", { bounds: bounds ?? null });
}
