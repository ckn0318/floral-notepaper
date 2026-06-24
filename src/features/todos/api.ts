import { invoke } from "@tauri-apps/api/core";
import type { TodoItem } from "./types";

/** Loads the persisted default to-do list (empty if none saved yet). */
export function getTodos(): Promise<TodoItem[]> {
  return invoke("todos_get");
}

/** Persists the full to-do list to disk (todolist/todolist0.json). */
export function saveTodos(items: TodoItem[]): Promise<void> {
  return invoke("todos_save", { items });
}
