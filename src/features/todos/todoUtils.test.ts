import { describe, expect, it } from "vitest";
import { createTodo, sortTodos } from "./todoUtils";
import type { TodoItem } from "./types";

function make(overrides: Partial<TodoItem>): TodoItem {
  return { id: "x", text: "t", done: false, priority: "white", pinned: false, ...overrides };
}

describe("todoUtils", () => {
  it("creates a fresh white, unpinned, undone item with trimmed text", () => {
    const todo = createTodo("  buy milk  ");
    expect(todo.text).toBe("buy milk");
    expect(todo.done).toBe(false);
    expect(todo.priority).toBe("white");
    expect(todo.pinned).toBe(false);
    expect(todo.id).toBeTruthy();
  });

  it("puts pinned items first while preserving insertion order otherwise", () => {
    const items = [
      make({ id: "a" }),
      make({ id: "b", pinned: true }),
      make({ id: "c" }),
      make({ id: "d", pinned: true }),
    ];
    expect(sortTodos(items).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not reorder when nothing is pinned", () => {
    const items = [make({ id: "a" }), make({ id: "b", done: true }), make({ id: "c" })];
    expect(sortTodos(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
