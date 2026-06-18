import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, WheelEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  createNote,
  deleteNote,
  getErrorMessage,
  getNote,
  listNotes,
  updateNote,
} from "../features/notes/api";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import type { Note, NoteMetadata } from "../features/notes/types";
import {
  countNoteChars,
  formatShortDate,
  getDisplayTitle,
  metadataFromNote,
} from "../features/notes/noteUtils";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  animateCurrentWindowBounds,
  closeCurrentWindow,
  getCurrentWindowBounds,
  recycleCurrentNotepad,
  setCurrentWindowAlwaysOnTop,
  showCurrentWindow,
  startCurrentWindowDrag,
  startCurrentWindowResize,
} from "../features/windows/controls";
import type { ResizeDirection } from "../features/windows/controls";
import { getConfig, saveConfig } from "../features/settings/api";
import {
  DEFAULT_TILE_COLOR,
  normalizeTileColor,
  resolveTileColor,
} from "../features/settings/tileColor";
import type { AppConfig, TileColorMode } from "../features/settings/types";
import {
  NOTE_SURFACE_ACTION_EVENT,
  type NoteSurfaceAction,
  surfaceActionFromEvent,
} from "../features/windows/surfaceActions";
import {
  NOTE_SURFACE_MODE_EVENT,
  getSurfaceTargetBounds,
  surfaceModeFromEvent,
} from "../features/windows/surfaceMode";
import type { NoteSurfaceMode } from "../features/windows/surfaceMode";
import { Tile } from "./Tile";
import { MarkdownEditor, type MarkdownEditorHandle } from "../features/markdown/MarkdownEditor";

type OpenMode = "new" | "open";
type NotePadStatus = "empty" | "opened" | "saved" | "dirty" | "saveFailed" | "copied";

const SURFACE_ZOOM_MIN = 0.75;
const SURFACE_ZOOM_MAX = 2;
const SURFACE_ZOOM_STEP = 0.05;
const NOTE_AUTO_SAVE_DELAY_MS = 800;

interface NotePadProps {
  initialNoteId?: string;
  initialSurfaceMode?: NoteSurfaceMode;
  initialTileColor?: string;
}

const surfaceResizeHandles: Array<{
  direction: ResizeDirection;
  className: string;
  size: string;
}> = [
  {
    direction: "NorthWest",
    size: "w-8 h-8",
    className: "top-0 left-0 cursor-nwse-resize",
  },
  {
    direction: "NorthEast",
    size: "w-5 h-5",
    className: "top-0 right-0 cursor-nesw-resize",
  },
  {
    direction: "SouthWest",
    size: "w-8 h-8",
    className: "bottom-0 left-0 cursor-nesw-resize",
  },
  {
    direction: "SouthEast",
    size: "w-5 h-5",
    className: "bottom-0 right-0 cursor-nwse-resize",
  },
];

function SurfaceResizeHandles() {
  return (
    <>
      {surfaceResizeHandles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          data-surface-resize-handle="true"
          data-resize-direction={handle.direction}
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

export function NotePad({
  initialNoteId,
  initialSurfaceMode = "pad",
  initialTileColor = DEFAULT_TILE_COLOR,
}: NotePadProps) {
  const { t } = useTranslation();
  const [surfaceMode, setSurfaceMode] = useState<NoteSurfaceMode>(initialSurfaceMode);
  const [mode, setMode] = useState<OpenMode>("new");
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [hoveredNote, setHoveredNote] = useState<string | null>(null);
  const [status, setStatus] = useState<NotePadStatus>("empty");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tileColorRaw, setTileColorRaw] = useState(normalizeTileColor(initialTileColor));
  const [tileColorMode, setTileColorMode] = useState<TileColorMode>("system");
  const [surfaceFontSize, setSurfaceFontSize] = useState(16);
  const [surfaceZoom, setSurfaceZoom] = useState(1);
  const [tileColor, setTileColor] = useState(() =>
    resolveTileColor("system", normalizeTileColor(initialTileColor)),
  );
  const [isExiting, setIsExiting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const configRef = useRef<AppConfig | null>(null);
  const notesRef = useRef<NoteMetadata[]>([]);
  const editingNoteIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<Note> | null>(null);
  const lastSavedRef = useRef({ title: "", content: "" });
  const isStandby = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("standby") === "1",
  );
  const hasEnteredOnce = useRef(false);
  // Set when the surface is closed via Esc, so the next Ctrl+Space resumes the
  // last interface instead of resetting to a blank draft. One-shot: consumed on
  // the next activation. Lives in the persistent (hidden) notepad window, so it
  // survives hide/show but not a window destroy or app restart (pad-only).
  const resumeNextOpenRef = useRef(false);
  const statusLabel = useMemo<Record<NotePadStatus, string>>(
    () => ({
      empty: t("notepad.status.empty", { defaultValue: "空" }),
      opened: t("notepad.status.opened", { defaultValue: "已打开" }),
      saved: t("notepad.status.saved", { defaultValue: "已保存" }),
      dirty: t("notepad.status.unsaved", { defaultValue: "未保存" }),
      saveFailed: t("notepad.status.saveFailed", { defaultValue: "保存失败" }),
      copied: t("notepad.status.copied", { defaultValue: "已复制" }),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () => ({
      new: t("notepad.tab.new", { defaultValue: "新建" }),
      edit: t("notepad.tab.edit", { defaultValue: "编辑" }),
      open: t("notepad.tab.open", { defaultValue: "打开" }),
    }),
    [t],
  );

  const refreshNotes = useCallback(async () => {
    const loadedNotes = await listNotes();
    setNotes(loadedNotes);
    return loadedNotes;
  }, []);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    editingNoteIdRef.current = editingNoteId;
  }, [editingNoteId]);

  const applyNote = useCallback((note: Note) => {
    setEditingNoteId(note.id);
    editingNoteIdRef.current = note.id;
    setTitle(note.title);
    setContent(note.content);
    lastSavedRef.current = { title: note.title, content: note.content };
    setMode("new");
    setStatus("opened");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedConfig] = await Promise.all([getConfig(), refreshNotes()]);
        if (!cancelled) {
          configRef.current = loadedConfig;
          setSurfaceFontSize(loadedConfig.surfaceFontSize ?? 16);
          setSurfaceZoom(loadedConfig.surfaceZoom ?? 1);
          setTileColorRaw(normalizeTileColor(loadedConfig.tileColor));
          setTileColorMode(loadedConfig.tileColorMode ?? "system");
          setTileColor(
            resolveTileColor(loadedConfig.tileColorMode ?? "system", loadedConfig.tileColor),
          );
        }
        if (initialNoteId) {
          const note = await getNote(initialNoteId);
          if (!cancelled) applyNote(note);
        }
      } catch (error) {
        if (!cancelled) setErrorMessage(getErrorMessage(error));
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, initialNoteId, refreshNotes]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      void refreshNotes().catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  useEffect(() => {
    if (isStandby.current) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          hasEnteredOnce.current = true;
          void showCurrentWindow()
            .then(() => editorRef.current?.focus())
            .catch(() => undefined);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<Partial<AppConfig>>("config-changed", (event) => {
      if (configRef.current) {
        configRef.current = { ...configRef.current, ...event.payload };
      }
      const mode = event.payload.tileColorMode ?? tileColorMode;
      const raw = event.payload.tileColor ?? tileColorRaw;
      setTileColorMode(mode);
      setTileColorRaw(normalizeTileColor(raw));
      setTileColor(resolveTileColor(mode, raw));
      if (event.payload.surfaceFontSize != null) setSurfaceFontSize(event.payload.surfaceFontSize);
      if (event.payload.surfaceZoom != null) setSurfaceZoom(event.payload.surfaceZoom);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    if (tileColorMode !== "system") return;
    const observer = new MutationObserver(() => {
      setTileColor(resolveTileColor("system", tileColorRaw));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    let myLabel = "";
    try {
      myLabel = getCurrentWindow().label;
    } catch {
      // not in Tauri environment (tests)
    }

    const unlisten = listen<{ label: string; fresh: boolean }>("notepad:activate", (event) => {
      if (event.payload.label !== myLabel) return;

      isStandby.current = false;
      hasEnteredOnce.current = true;
      setIsExiting(false);

      const shouldResume = !event.payload.fresh && resumeNextOpenRef.current;
      resumeNextOpenRef.current = false;

      if (shouldResume) {
        // Keep the last note/content/mode; just bring the window back.
        void refreshNotes().catch(() => undefined);
        void showCurrentWindow()
          .then(() => editorRef.current?.focus())
          .catch(() => undefined);
        return;
      }

      editingNoteIdRef.current = null;
      lastSavedRef.current = { title: "", content: "" };
      setEditingNoteId(null);
      setTitle("");
      setContent("");
      setMode("new");
      setStatus("empty");
      setErrorMessage(null);
      setSurfaceMode("pad");
      void refreshNotes().catch(() => undefined);
      void showCurrentWindow()
        .then(() => editorRef.current?.focus())
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  const saveNote = useCallback(
    async (nextContent = content) => {
      const runSave = async () => {
        const noteId = editingNoteIdRef.current;
        const existingCategory = notesRef.current.find((n) => n.id === noteId)?.category ?? "";
        const request = { title, content: nextContent, category: existingCategory };
        const note = noteId ? await updateNote(noteId, request) : await createNote(request);

        editingNoteIdRef.current = note.id;
        setEditingNoteId(note.id);
        setNotes((current) => {
          const metadata = metadataFromNote(note);
          const exists = current.some((item) => item.id === note.id);
          const next = exists
            ? current.map((item) => (item.id === note.id ? metadata : item))
            : [metadata, ...current];
          return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        });
        lastSavedRef.current = { title, content: nextContent };
        setStatus("saved");
        return note;
      };

      const previousSave = saveInFlightRef.current;
      const savePromise = (previousSave ?? Promise.resolve()).then(runSave, runSave);
      saveInFlightRef.current = savePromise;
      try {
        return await savePromise;
      } finally {
        if (saveInFlightRef.current === savePromise) {
          saveInFlightRef.current = null;
        }
      }
    },
    [content, title],
  );

  const imageBaseDir = useImageBaseDir();

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (editingNoteIdRef.current) return editingNoteIdRef.current;
    setErrorMessage(null);
    const nextContent = editorRef.current?.getMarkdown() ?? content;
    setContent(nextContent);
    const note = await saveNote(nextContent);
    return note.id;
  }, [content, saveNote]);

  const tileNoteId = editingNoteId ?? initialNoteId ?? "";

  const switchSurfaceMode = useCallback(async (nextMode: NoteSurfaceMode) => {
    setSurfaceMode(nextMode);

    try {
      if (nextMode === "tile") {
        await setCurrentWindowAlwaysOnTop(true);
      }

      const currentBounds = await getCurrentWindowBounds();
      await animateCurrentWindowBounds(getSurfaceTargetBounds(nextMode, currentBounds));
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    function handleSurfaceModeRequest(event: Event) {
      const nextMode = surfaceModeFromEvent(event);
      if (!nextMode) return;
      void switchSurfaceMode(nextMode);
    }

    window.addEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    };
  }, [switchSurfaceMode]);

  useEffect(() => {
    if (surfaceMode !== "tile") return;
    void setCurrentWindowAlwaysOnTop(true).catch(() => undefined);
  }, [surfaceMode]);

  const handleSave = useCallback(async () => {
    setErrorMessage(null);
    try {
      const nextContent = editorRef.current?.getMarkdown() ?? content;
      setContent(nextContent);
      await saveNote(nextContent);
    } catch (error) {
      setStatus("saveFailed");
      setErrorMessage(getErrorMessage(error));
    }
  }, [content, saveNote]);

  const adjustSurfaceZoom = useCallback((delta: number) => {
    setSurfaceZoom((current) => {
      const next = Math.min(
        SURFACE_ZOOM_MAX,
        Math.max(SURFACE_ZOOM_MIN, Number((current + delta).toFixed(2))),
      );
      if (next === current) return current;

      const config = configRef.current;
      if (config) {
        const nextConfig = { ...config, surfaceZoom: next };
        configRef.current = nextConfig;
        void saveConfig(nextConfig).catch((error) => {
          setErrorMessage(getErrorMessage(error));
        });
      }

      return next;
    });
  }, []);

  const handleSurfaceZoomWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      adjustSurfaceZoom(event.deltaY < 0 ? SURFACE_ZOOM_STEP : -SURFACE_ZOOM_STEP);
    },
    [adjustSurfaceZoom],
  );

  useEffect(() => {
    if (mode !== "new" || status !== "dirty") return;
    if (configRef.current?.noteSurfaceAutoSave === false) return;

    const scheduledContent = editorRef.current?.getMarkdown() ?? content;
    const hasDraftContent = title.trim().length > 0 || scheduledContent.trim().length > 0;
    if (!editingNoteIdRef.current && !hasDraftContent) return;
    if (lastSavedRef.current.title === title && lastSavedRef.current.content === scheduledContent) {
      return;
    }

    const timer = window.setTimeout(() => {
      const nextContent = editorRef.current?.getMarkdown() ?? content;
      setContent(nextContent);
      void saveNote(nextContent).catch((error) => {
        setStatus("saveFailed");
        setErrorMessage(getErrorMessage(error));
      });
    }, NOTE_AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [content, mode, saveNote, status, title]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void handleSave();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  const handleOpenNote = useCallback(
    async (noteId: string) => {
      setErrorMessage(null);
      try {
        const note = await getNote(noteId);
        applyNote(note);
        await switchSurfaceMode("pad");
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      }
    },
    [applyNote, switchSurfaceMode],
  );

  useEffect(() => {
    const unlisten = listen<string>("notepad:open-note", (event) => {
      void handleOpenNote(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleOpenNote]);

  const handlePin = async () => {
    setErrorMessage(null);
    try {
      await switchSurfaceMode("tile");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleClose = useCallback(
    (options?: { resume?: boolean }) => {
      // Esc arms resume (content + window geometry); × / 取消钉屏 (default) leaves
      // it off → next open is a fresh draft at the default position/size.
      const resume = options?.resume ?? false;
      resumeNextOpenRef.current = resume;
      setIsExiting(true);
      const closeSurface =
        surfaceMode === "tile" ? closeCurrentWindow() : recycleCurrentNotepad(resume);
      void closeSurface.catch((error) => {
        setIsExiting(false);
        setErrorMessage(getErrorMessage(error));
      });
    },
    [surfaceMode],
  );

  const closeWithAutoSave = useCallback(async () => {
    const nextContent = editorRef.current?.getMarkdown() ?? content;
    const hasDraftContent = title.trim().length > 0 || nextContent.trim().length > 0;
    const changed =
      lastSavedRef.current.title !== title || lastSavedRef.current.content !== nextContent;
    const shouldSave =
      configRef.current?.noteSurfaceAutoSave !== false &&
      changed &&
      (editingNoteIdRef.current != null || hasDraftContent);

    if (shouldSave) {
      setContent(nextContent);
      try {
        await saveNote(nextContent);
      } catch (error) {
        setStatus("saveFailed");
        setErrorMessage(getErrorMessage(error));
      }
    }

    handleClose({ resume: true });
  }, [content, title, saveNote, handleClose]);

  useEffect(() => {
    function handleEscClose(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Window-local only (not a global shortcut): fires solely when this
      // notepad/tile window is focused, so Esc never clashes with other apps.
      // Let an open context menu consume Esc first.
      if (document.querySelector("[data-context-menu-popover]")) return;
      event.preventDefault();
      void closeWithAutoSave();
    }

    document.addEventListener("keydown", handleEscClose);
    return () => document.removeEventListener("keydown", handleEscClose);
  }, [closeWithAutoSave]);

  const copyTileContent = useCallback(async () => {
    setErrorMessage(null);
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error(t("notepad.error.copyUnsupported", { defaultValue: "当前环境不支持复制" }));
      }
      await clipboard.writeText(content);
      setStatus("copied");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, [content, t]);

  useEffect(() => {
    function handleSurfaceAction(action: NoteSurfaceAction) {
      if (!action) return;

      if (action === "copy") {
        void copyTileContent();
        return;
      }

      if (action === "save") {
        void handleSave();
        return;
      }

      if (action === "close") {
        void handleClose();
        return;
      }

      void switchSurfaceMode("pad");
    }

    function handleSurfaceActionRequest(event: Event) {
      const action = surfaceActionFromEvent(event);
      if (action) handleSurfaceAction(action);
    }

    const unlisten = listen<NoteSurfaceAction>("surface-action", (event) => {
      handleSurfaceAction(event.payload);
    });

    window.addEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
      void unlisten.then((fn) => fn());
    };
  }, [copyTileContent, handleClose, handleSave, switchSurfaceMode]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea,[contenteditable='true'],.milkdown-editor-shell"))
      return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const resetDraft = () => {
    editingNoteIdRef.current = null;
    lastSavedRef.current = { title: "", content: "" };
    setEditingNoteId(null);
    setTitle("");
    setContent("");
    setMode("new");
    setStatus("empty");
    setErrorMessage(null);
  };

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      setErrorMessage(null);
      try {
        await deleteNote(noteId);
        setNotes((current) => current.filter((note) => note.id !== noteId));
        if (editingNoteId === noteId) {
          resetDraft();
        }
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      }
    },
    [editingNoteId],
  );

  const isTile = surfaceMode === "tile";
  const tileTitle = title.trim();
  const enterClass = hasEnteredOnce.current ? "" : "animate-window-enter";
  const surfaceWrapperClassName = `w-full h-screen flex flex-col bg-transparent p-0 ${isExiting ? "animate-window-exit" : enterClass}`;
  const padSurfaceClassName =
    "app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col flex-1 border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)] transition-all duration-200 ease-out";

  return (
    <div className={surfaceWrapperClassName}>
      {isTile ? (
        <Tile
          title={tileTitle || undefined}
          content={errorMessage || content}
          color={tileColor}
          fontSize={surfaceFontSize}
          renderMarkdown={!errorMessage}
          imageBaseDir={imageBaseDir ?? undefined}
          width="100%"
          className="h-full cursor-default"
          data-surface-mode={surfaceMode}
          data-context-menu="tile"
          data-note-id={tileNoteId}
          onMouseDown={handleDrag}
          onWheel={handleSurfaceZoomWheel}
        >
          <button
            type="button"
            aria-label="取消钉屏"
            title="取消钉屏"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void handleClose()}
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full text-ink-ghost/70 hover:text-red-400 hover:bg-danger-bg/80 transition-colors cursor-pointer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <SurfaceResizeHandles />
        </Tile>
      ) : (
        <div className={padSurfaceClassName} data-surface-mode={surfaceMode}>
          <>
            <div
              className="flex items-center justify-between px-4 pt-3 pb-0 cursor-default"
              onMouseDown={handleDrag}
            >
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setMode("new")}
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                    mode === "new"
                      ? "text-bamboo font-medium"
                      : "text-ink-ghost hover:text-ink-faint"
                  }`}
                >
                  {tabLabels.edit}
                  {mode === "new" && (
                    <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                  )}
                </button>
                <button
                  onClick={() => setMode("open")}
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                    mode === "open"
                      ? "text-bamboo font-medium"
                      : "text-ink-ghost hover:text-ink-faint"
                  }`}
                >
                  {tabLabels.open}
                  {mode === "open" && (
                    <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => void handlePin()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
                  title={t("notepad.tooltip.pinToTile", { defaultValue: "转为磁贴" })}
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
                  >
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
                  </svg>
                </button>

                <button
                  onClick={() => void handleClose()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:bg-danger-bg hover:text-red-400 transition-all duration-200 cursor-pointer"
                  title={t("notepad.tooltip.close", { defaultValue: "关闭" })}
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
              </div>
            </div>

            <div className="mx-4 mt-1 h-px bg-paper-deep/50" />

            {mode === "new" ? (
              <div
                data-pad-editor-body="true"
                className="px-4 pt-3 pb-2 flex flex-col flex-1 min-h-0"
                onWheel={handleSurfaceZoomWheel}
              >
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setStatus("dirty");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "ArrowDown") {
                      event.preventDefault();
                      editorRef.current?.focus();
                    }
                  }}
                  placeholder={t("notepad.placeholder.title", { defaultValue: "标签（可选）" })}
                  className="w-full font-display font-medium text-ink placeholder:text-ink-ghost/60 mb-2 tracking-wide shrink-0"
                  style={{ fontSize: `${surfaceFontSize}px` }}
                />

                <MarkdownEditor
                  ref={editorRef}
                  value={content}
                  noteId={editingNoteId}
                  imageBaseDir={imageBaseDir}
                  zoom={surfaceZoom}
                  onChange={setContent}
                  onDirty={() => setStatus("dirty")}
                  onEnsureNoteSaved={ensureNoteSaved}
                  onError={setErrorMessage}
                  t={t}
                  placeholder={t("notepad.placeholder.content", { defaultValue: "写点什么……" })}
                />

                <div className="flex items-center justify-between mt-auto pt-2 border-t border-paper-deep/30 shrink-0">
                  <span className="text-[11px] text-ink-ghost font-mono tabular-nums truncate max-w-[170px]">
                    {errorMessage ??
                      `${countNoteChars(content)} ${t("common.wordCountUnit", { defaultValue: "字" })} · ${statusLabel[status]}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={resetDraft}
                      className="px-4 py-1.5 text-[12px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                    >
                      {t("notepad.tab.new", { defaultValue: "新建" })}
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      className="px-4 py-1.5 text-[12px] text-cloud bg-bamboo hover:bg-bamboo-light rounded-lg transition-all duration-200 font-medium cursor-pointer"
                    >
                      {t("common.save", { defaultValue: "保存" })}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-2 flex-1 min-h-0 overflow-y-auto">
                <div className="space-y-0.5">
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      onClick={() => void handleOpenNote(note.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void handleOpenNote(note.id);
                        }
                      }}
                      onMouseEnter={() => setHoveredNote(note.id)}
                      onMouseLeave={() => setHoveredNote(null)}
                      role="button"
                      tabIndex={0}
                      className="relative w-full text-left px-3.5 py-3 pr-32 rounded-xl transition-all duration-200 cursor-pointer group hover:bg-paper-warm/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bamboo/60"
                    >
                      <div className="mb-0.5">
                        <span className="block text-[13px] font-display font-medium text-ink-soft group-hover:text-ink transition-colors truncate">
                          {getDisplayTitle(note)}
                        </span>
                      </div>
                      <p className="text-[12px] text-ink-ghost leading-relaxed line-clamp-1 group-hover:text-ink-faint transition-colors">
                        {note.preview || t("common.blankNote", { defaultValue: "空白笔记" })}
                      </p>
                      {hoveredNote === note.id && (
                        <div className="mt-1.5 h-px bg-bamboo/10 transition-all duration-300" />
                      )}
                      <span className="absolute right-20 top-3 text-[11px] text-ink-ghost font-mono tabular-nums">
                        {formatShortDate(note.updatedAt)}
                      </span>
                      <button
                        type="button"
                        aria-label={t("common.delete", { defaultValue: "删除" })}
                        title={t("common.delete", { defaultValue: "删除" })}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteNote(note.id);
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        className="absolute right-5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-md text-ink-ghost/80 hover:text-red-400 hover:bg-danger-bg transition-all cursor-pointer"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v5" />
                          <path d="M14 11v5" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {notes.length === 0 && (
                    <div className="px-4 py-8 text-center text-[12px] text-ink-ghost">
                      {t("notepad.emptyState", { defaultValue: "还没有可打开的笔记" })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
          <SurfaceResizeHandles />
        </div>
      )}
    </div>
  );
}
