import type { TodoItem, TodoPriority } from "./types";

/** Priority order shown in the right-click flag picker (red, yellow, white). */
export const TODO_PRIORITIES: TodoPriority[] = ["red", "yellow", "white"];

function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Builds a fresh, unpinned, white-priority item from trimmed input text. */
export function createTodo(text: string): TodoItem {
  return {
    id: newId(),
    text: text.trim(),
    done: false,
    priority: "white",
    pinned: false,
  };
}

/** Stable display order: pinned items first (keeping their relative order),
 *  then the rest in their original (insertion) order. Toggling `done` or
 *  changing priority never reorders an item — only pinning does. */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
