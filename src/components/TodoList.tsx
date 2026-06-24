import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  animateCurrentWindowBounds,
  closeCurrentWindow,
  getCurrentWindowBounds,
  setCurrentWindowAlwaysOnTop,
  setCurrentWindowBounds,
  showCurrentWindow,
  startCurrentWindowDrag,
  startCurrentWindowResize,
} from "../features/windows/controls";
import type { ResizeDirection } from "../features/windows/controls";
import type { WindowBounds } from "../features/windows/api";
import { createTodo, sortTodos, TODO_PRIORITIES } from "../features/todos/todoUtils";
import { getTodos, saveTodos } from "../features/todos/api";
import type { TodoItem, TodoPriority } from "../features/todos/types";

// Edge-dock auto-hide tuning (physical px / ms).
const DOCK_THRESHOLD = 12; // how close the window top must be to y=0 to dock
const TAB_W = 180; // collapsed tab pill size (fits 旗标 + 待办清单-N条)
const TAB_H = 40;
const COLLAPSE_DELAY = 300; // grace period after the pointer leaves before hiding
const SLIDE_MS = 160; // collapse (panel → tab) duration
const REVEAL_MS = 220; // reveal (tab → panel) downward-unfold duration
// Floor for the remembered expanded size, so a degenerate capture can never leave
// the panel stuck too small to reveal.
const MIN_EXPANDED_W = 240;
const MIN_EXPANDED_H = 160;

/** Checkbox colour per priority. White = neutral / no priority. */
const PRIORITY_COLOR: Record<TodoPriority, string> = {
  red: "#e5484d",
  yellow: "#ffb224",
  white: "#9b988f",
};

const resizeHandles: Array<{ direction: ResizeDirection; className: string; size: string }> = [
  { direction: "NorthWest", size: "w-8 h-8", className: "top-0 left-0 cursor-nwse-resize" },
  { direction: "NorthEast", size: "w-5 h-5", className: "top-0 right-0 cursor-nesw-resize" },
  { direction: "SouthWest", size: "w-8 h-8", className: "bottom-0 left-0 cursor-nesw-resize" },
  { direction: "SouthEast", size: "w-5 h-5", className: "bottom-0 right-0 cursor-nwse-resize" },
];

function ResizeHandles() {
  return (
    <>
      {resizeHandles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          onMouseDown={(event) => {
            event.stopPropagation();
            void startCurrentWindowResize(handle.direction).catch(() => undefined);
          }}
          className={`absolute ${handle.size} opacity-0 ${handle.className}`}
        />
      ))}
    </>
  );
}

interface ItemMenu {
  id: string;
  x: number;
  y: number;
}

function FlagIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function Checkbox({
  done,
  color,
  onToggle,
}: {
  done: boolean;
  color: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="mt-0.5 shrink-0 w-[18px] h-[18px] rounded-[6px] flex items-center justify-center transition-all duration-150 cursor-pointer"
      style={{
        border: `2px solid ${color}`,
        backgroundColor: done ? color : "transparent",
      }}
    >
      {done && (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#1a1917"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}

export function TodoList() {
  const { t } = useTranslation();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<ItemMenu | null>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  // collapsed = currently hidden as a slim tab at the top edge.
  const [collapsed, setCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasEntered = useRef(false);
  // Persistence: don't save until the initial disk load has populated state, and
  // keep a live ref so close-handlers can flush the latest list synchronously.
  const loadedRef = useRef(false);
  const todosRef = useRef<TodoItem[]>([]);

  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);

  // Load the persisted list once on mount.
  useEffect(() => {
    let cancelled = false;
    getTodos()
      .then((items) => {
        if (!cancelled) setTodos(items);
      })
      .catch(() => undefined)
      .finally(() => {
        loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on change (debounced), but only after the initial load so the empty
  // starting state never overwrites a saved list.
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveTodos(todos).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [todos]);

  // Edge-dock auto-hide state (kept in refs so the window-level event handlers,
  // installed once, always read the latest values).
  const dockedRef = useRef(false);
  const collapsedRef = useRef(false);
  const animatingRef = useRef(false);
  const draggingRef = useRef(false);
  const expandedRef = useRef<WindowBounds | null>(null);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  // The window is created hidden (visible:false); show + focus it once mounted,
  // mirroring how the notepad surfaces present themselves. Re-assert always-on-top.
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        hasEntered.current = true;
        void showCurrentWindow()
          .then(() => {
            void setCurrentWindowAlwaysOnTop(true).catch(() => undefined);
            inputRef.current?.focus();
          })
          .catch(() => undefined);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Edge-dock auto-hide: drag the window to the top of the screen → it snaps and,
  // once the pointer leaves, slides up into a slim tab; hovering the tab reveals
  // it again. Only active while docked to the top edge.
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenMoved: (() => void) | null = null;
    let moveTimer: number | null = null;
    let collapseTimer: number | null = null;

    const clearCollapse = () => {
      if (collapseTimer != null) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
    };

    const tabBoundsFor = (exp: WindowBounds): WindowBounds => ({
      x: Math.round(exp.x + (exp.width - TAB_W) / 2),
      y: 0,
      width: TAB_W,
      height: TAB_H,
    });

    // Snap the expanded geometry to the top edge, flooring the size so a bad read
    // never produces an un-revealable panel.
    const captureExpanded = (bounds: WindowBounds): WindowBounds => ({
      x: bounds.x,
      y: 0,
      width: Math.max(bounds.width, MIN_EXPANDED_W),
      height: Math.max(bounds.height, MIN_EXPANDED_H),
    });

    const evaluateDock = async () => {
      if (animatingRef.current || collapsedRef.current) return;
      const bounds = await getCurrentWindowBounds().catch(() => null);
      if (!bounds) return;
      if (bounds.y <= DOCK_THRESHOLD) {
        dockedRef.current = true;
        const expanded = captureExpanded(bounds);
        expandedRef.current = expanded;
        if (bounds.y !== 0) {
          animatingRef.current = true;
          await animateCurrentWindowBounds(expanded, 120).catch(() => undefined);
          animatingRef.current = false;
        }
      } else {
        dockedRef.current = false;
        expandedRef.current = null;
      }
    };

    const collapse = async () => {
      if (!dockedRef.current || collapsedRef.current || animatingRef.current) return;
      // Re-capture geometry in case the panel was resized while open.
      const bounds = await getCurrentWindowBounds().catch(() => null);
      if (bounds) {
        expandedRef.current = captureExpanded(bounds);
      }
      const exp = expandedRef.current;
      if (!exp) return;
      setCollapsed(true);
      collapsedRef.current = true;
      animatingRef.current = true;
      await animateCurrentWindowBounds(tabBoundsFor(exp), SLIDE_MS).catch(() => undefined);
      animatingRef.current = false;
    };

    const reveal = async () => {
      if (!collapsedRef.current || animatingRef.current) return;
      // Render the panel first, then unfold downward: snap to full width as a thin
      // strip at the top edge, then animate only the height open so the content is
      // revealed top-to-bottom (instead of the tab pill stretching up to size).
      collapsedRef.current = false;
      setCollapsed(false);
      const exp = expandedRef.current;
      if (!exp) return;
      animatingRef.current = true;
      await setCurrentWindowBounds({
        x: exp.x,
        y: 0,
        width: exp.width,
        height: Math.min(TAB_H, exp.height),
      }).catch(() => undefined);
      await animateCurrentWindowBounds(exp, REVEAL_MS).catch(() => undefined);
      animatingRef.current = false;
    };

    const onMoved = () => {
      // Ignore our own programmatic moves and any movement while collapsed.
      if (animatingRef.current || collapsedRef.current) return;
      // A stream of move events means the user is dragging — flag it and cancel
      // any pending hide so the panel never collapses mid-drag. Docking is only
      // evaluated once movement settles.
      draggingRef.current = true;
      clearCollapse();
      if (moveTimer != null) clearTimeout(moveTimer);
      moveTimer = window.setTimeout(() => {
        draggingRef.current = false;
        void evaluateDock();
      }, 220);
    };

    const onPointerEnter = () => {
      clearCollapse();
      if (collapsedRef.current) void reveal();
    };

    const onPointerLeave = () => {
      if (!dockedRef.current || collapsedRef.current) return;
      // Never hide while the user is dragging the window (the cursor slipping past
      // the moving edge would otherwise trigger a collapse).
      if (draggingRef.current) return;
      // Otherwise hide whenever the pointer leaves the window, even mid-typing /
      // with the context menu open.
      clearCollapse();
      collapseTimer = window.setTimeout(() => void collapse(), COLLAPSE_DELAY);
    };

    void win
      .onMoved(() => onMoved())
      .then((fn) => {
        if (disposed) fn();
        else unlistenMoved = fn;
      });

    const root = document.documentElement;
    root.addEventListener("mouseenter", onPointerEnter);
    root.addEventListener("mouseleave", onPointerLeave);

    // Opened at the fixed default spot (top edge): arm docking once positioned so
    // it can auto-hide upward without being dragged there first.
    const armTimer = window.setTimeout(() => void evaluateDock(), 350);

    return () => {
      disposed = true;
      unlistenMoved?.();
      root.removeEventListener("mouseenter", onPointerEnter);
      root.removeEventListener("mouseleave", onPointerLeave);
      if (moveTimer != null) clearTimeout(moveTimer);
      clearTimeout(armTimer);
      clearCollapse();
    };
  }, []);

  const close = useCallback(() => {
    // Flush the latest list before the window is destroyed, so edits made within
    // the save debounce window aren't lost.
    void saveTodos(todosRef.current)
      .catch(() => undefined)
      .finally(() => {
        void closeCurrentWindow().catch(() => undefined);
      });
  }, []);

  // Esc closes the to-do window only — the notepad is a separate window and is
  // left untouched.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (menu) {
        setMenu(null);
        return;
      }
      event.preventDefault();
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, menu]);

  // Dismiss the right-click menu on any outside click.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [menu]);

  const addTodo = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setTodos((current) => [...current, createTodo(text)]);
    setDraft("");
  }, [draft]);

  const toggleDone = useCallback((id: string) => {
    setTodos((current) =>
      current.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)),
    );
  }, []);

  const removeTodo = useCallback((id: string) => {
    setTodos((current) => current.filter((todo) => todo.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setTodos((current) => current.filter((todo) => !todo.done));
  }, []);

  const setPriority = useCallback((id: string, priority: TodoPriority) => {
    setTodos((current) => current.map((todo) => (todo.id === id ? { ...todo, priority } : todo)));
    setMenu(null);
  }, []);

  const togglePinned = useCallback((id: string) => {
    setTodos((current) =>
      current.map((todo) => (todo.id === id ? { ...todo, pinned: !todo.pinned } : todo)),
    );
    setMenu(null);
  }, []);

  const openItemMenu = useCallback((event: MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 168;
    const menuHeight = 96;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 6);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 6);
    setMenu({ id, x, y });
  }, []);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,[role='checkbox']")) return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  // Active items sort pinned-first; completed items drop into the "已完成"
  // section below in their existing order.
  const activeTodos = useMemo(() => sortTodos(todos.filter((todo) => !todo.done)), [todos]);
  const completedTodos = useMemo(() => todos.filter((todo) => todo.done), [todos]);
  const menuItem = menu ? todos.find((todo) => todo.id === menu.id) : undefined;
  const enterClass = hasEntered.current ? "" : "animate-window-enter";

  const renderRow = (todo: TodoItem) => (
    <li
      key={todo.id}
      onContextMenu={(event) => openItemMenu(event, todo.id)}
      className="group relative flex items-start gap-2.5 px-2.5 py-1.5 my-0.5 rounded-lg transition-colors duration-150 todo-item-hover"
    >
      <Checkbox
        done={todo.done}
        color={PRIORITY_COLOR[todo.priority]}
        onToggle={() => toggleDone(todo.id)}
      />
      <span
        className={`flex-1 min-w-0 text-[13.5px] leading-snug break-words ${
          todo.done ? "line-through todo-text-faint" : "todo-text"
        }`}
      >
        {todo.text}
      </span>
      {todo.pinned && (
        <span
          className="shrink-0 mt-0.5 todo-text-faint"
          title={t("todo.pinned", { defaultValue: "已置顶" })}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M14 4v5l3 3v2h-5v5l-1 1-1-1v-5H4v-2l3-3V4z" />
          </svg>
        </span>
      )}
      <button
        type="button"
        aria-label={t("common.delete", { defaultValue: "删除" })}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          removeTodo(todo.id);
        }}
        className="shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 todo-icon-btn transition-all cursor-pointer"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
        </svg>
      </button>
    </li>
  );

  // Collapsed: a slim pill hugging the top edge; hovering it slides the panel
  // back into view (handled by the auto-hide effect's pointer-enter).
  if (collapsed) {
    // Glance summary: urgency flag by highest pending priority (red > yellow >
    // white; none when there are no pending items), title, and the pending count
    // in yellow.
    const pending = todos.filter((todo) => !todo.done);
    const flagColor = pending.some((todo) => todo.priority === "red")
      ? PRIORITY_COLOR.red
      : pending.some((todo) => todo.priority === "yellow")
        ? PRIORITY_COLOR.yellow
        : pending.length > 0
          ? "#d8d5cd"
          : null;
    return (
      <div className="w-full h-screen flex bg-transparent">
        <div className="todo-tab app-surface-frame w-full h-full flex items-center justify-center gap-1.5 select-none cursor-pointer px-3">
          {flagColor && (
            <span className="shrink-0 flex items-center" style={{ color: flagColor }}>
              <FlagIcon filled size={18} />
            </span>
          )}
          <span className="text-[14.5px] font-display font-semibold tracking-wide truncate todo-text">
            {t("todo.title", { defaultValue: "待办清单" })}-{pending.length}条
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full h-screen flex flex-col bg-transparent ${enterClass}`}>
      <div className="todo-panel app-surface-frame relative w-full h-full min-h-0 flex flex-col overflow-hidden">
        {/* Header */}
        <header
          className="flex items-center justify-between px-4 pt-3 pb-2 cursor-default shrink-0"
          onMouseDown={handleDrag}
        >
          <span className="text-[16px] font-display font-semibold tracking-wide todo-text">
            {t("todo.title", { defaultValue: "待办清单" })}
          </span>
          <button
            type="button"
            onClick={close}
            title={t("notepad.tooltip.close", { defaultValue: "关闭" })}
            className="group w-7 h-7 flex items-center justify-center rounded-lg todo-icon-btn hover:bg-danger-bg transition-all duration-200 cursor-pointer"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {/* Add task */}
        <div className="px-3 pb-1 shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl todo-add-row">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="todo-text-faint shrink-0"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTodo();
                }
              }}
              placeholder={t("todo.addTask", { defaultValue: "添加任务" })}
              className="w-full bg-transparent border-none outline-none text-[13.5px] todo-input"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hidden px-1.5 py-1">
          {activeTodos.length === 0 && completedTodos.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12.5px] todo-text-faint">
              {t("todo.empty", { defaultValue: "还没有待办,在上面添加一条吧" })}
            </div>
          ) : (
            <>
              {activeTodos.length > 0 && <ul>{activeTodos.map(renderRow)}</ul>}

              {completedTodos.length > 0 && (
                <div className="mt-1">
                  <div className="flex items-center justify-between pl-2.5 pr-2 py-1">
                    <button
                      type="button"
                      onClick={() => setCompletedCollapsed((value) => !value)}
                      className="flex items-center gap-1 text-[12.5px] todo-text-faint hover:text-[#cfccc4] transition-colors cursor-pointer"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{
                          transform: completedCollapsed ? "rotate(-90deg)" : "none",
                          transition: "transform 0.15s ease",
                        }}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                      {t("todo.completed", { defaultValue: "已完成" })} {completedTodos.length}
                    </button>
                    <button
                      type="button"
                      title={t("todo.clearCompleted", { defaultValue: "删除全部已完成" })}
                      aria-label={t("todo.clearCompleted", { defaultValue: "删除全部已完成" })}
                      onClick={clearCompleted}
                      className="w-6 h-6 flex items-center justify-center rounded todo-icon-btn hover:bg-danger-bg transition-all cursor-pointer"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
                      </svg>
                    </button>
                  </div>
                  {!completedCollapsed && <ul>{completedTodos.map(renderRow)}</ul>}
                </div>
              )}
            </>
          )}
        </div>

        <ResizeHandles />
      </div>

      {/* Right-click item menu: priority flags + pin */}
      {menu && menuItem && (
        <div
          data-context-menu-popover="true"
          className="fixed z-[9999] py-2 px-1 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg select-none animate-menu-enter"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-1 px-2 pb-1.5">
            {TODO_PRIORITIES.map((priority) => {
              const active = menuItem.priority === priority;
              return (
                <button
                  key={priority}
                  type="button"
                  title={t(`todo.priority.${priority}`, {
                    defaultValue: priority === "red" ? "高" : priority === "yellow" ? "中" : "无",
                  })}
                  onClick={() => setPriority(menu.id, priority)}
                  className={`w-7 h-7 flex items-center justify-center rounded-md transition-all cursor-pointer ${
                    active ? "bg-bamboo-mist/70" : "hover:bg-paper-deep/40"
                  }`}
                  style={{ color: PRIORITY_COLOR[priority] }}
                >
                  <FlagIcon filled={active} />
                </button>
              );
            })}
          </div>
          <div className="mx-2 my-1 h-px bg-paper-deep/40" />
          <button
            type="button"
            onClick={() => togglePinned(menu.id)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo rounded transition-colors cursor-pointer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M14 4v5l3 3v2h-5v5l-1 1-1-1v-5H4v-2l3-3V4z" />
            </svg>
            {menuItem.pinned
              ? t("todo.unpin", { defaultValue: "取消置顶" })
              : t("todo.pin", { defaultValue: "置顶" })}
          </button>
        </div>
      )}
    </div>
  );
}
