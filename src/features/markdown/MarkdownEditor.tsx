import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent } from "react";
import type { TFunction } from "i18next";
import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { clipboard } from "@milkdown/plugin-clipboard";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { NodeSelection, Plugin } from "@milkdown/prose/state";
import { history, redo, undo } from "@milkdown/prose/history";
import { keymap } from "@milkdown/prose/keymap";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/prose/view";
import { $prose, getMarkdown, insert, replaceAll } from "@milkdown/utils";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getImageFiles, MIME_TO_EXT, saveImageFilesAsMarkdown } from "../images/imageFiles";

export interface MarkdownEditorHandle {
  focus: () => void;
  getMarkdown: () => string;
  insertMarkdown: (markdown: string) => void;
}

interface MarkdownEditorProps {
  value: string;
  noteId: string | null;
  imageBaseDir?: string | null;
  zoom: number;
  placeholder?: string;
  onChange: (markdown: string) => void;
  onDirty: () => void;
  onEnsureNoteSaved: () => Promise<string | null>;
  onError?: (message: string) => void;
  t?: TFunction;
}

function resolveImageSrc(src: string, imageBaseDir?: string | null) {
  if (src.startsWith("images/") && imageBaseDir) {
    return convertFileSrc(`${imageBaseDir}/${src}`);
  }
  return src;
}

const IMAGE_WIDTH_TITLE_PATTERN = /(?:^|\s)width=(\d{2,5})(?=\s|$)/;
const MIN_IMAGE_WIDTH = 20;
/** Freshly inserted images are fitted to at most this fraction of the editor
 *  content width (the remainder reads as a gutter, matching the old default). */
const IMAGE_INSERT_WIDTH_RATIO = 0.85;

function getImageWidth(title: string): number | null {
  const match = title.match(IMAGE_WIDTH_TITLE_PATTERN);
  if (!match) return null;
  const width = Number(match[1]);
  return Number.isFinite(width) ? width : null;
}

function getImageDisplayTitle(title: string) {
  return title.replace(IMAGE_WIDTH_TITLE_PATTERN, "").trim();
}

function setImageWidthTitle(title: string, width: number) {
  const baseTitle = getImageDisplayTitle(title);
  return [baseTitle, `width=${Math.round(width)}`].filter(Boolean).join(" ");
}

function getEditorZoom(dom: HTMLElement) {
  const editor = dom.closest<HTMLElement>(".ProseMirror");
  const zoom = editor ? Number.parseFloat(getComputedStyle(editor).zoom || "1") : 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function getMaxImageWidth(dom: HTMLElement) {
  const editor = dom.closest<HTMLElement>(".ProseMirror");
  if (!editor) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_IMAGE_WIDTH, editor.getBoundingClientRect().width / getEditorZoom(dom));
}

function clampImageWidth(width: number, dom: HTMLElement) {
  return Math.min(getMaxImageWidth(dom), Math.max(MIN_IMAGE_WIDTH, width));
}

function createImageNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
  imageBaseDir?: string | null,
): NodeView {
  let currentNode = node;
  const dom = document.createElement("span");
  const image = document.createElement("img");
  const handle = document.createElement("span");

  dom.className = "milkdown-image-node";
  dom.contentEditable = "false";
  handle.className = "milkdown-image-resize-handle";
  handle.contentEditable = "false";
  dom.append(image, handle);

  function sync(nextNode: ProseNode) {
    currentNode = nextNode;
    const src = String(nextNode.attrs.src ?? "");
    const alt = String(nextNode.attrs.alt ?? "");
    const title = String(nextNode.attrs.title ?? "");
    const width = getImageWidth(title);
    const displayTitle = getImageDisplayTitle(title);
    image.src = resolveImageSrc(src, imageBaseDir);
    image.alt = alt;
    image.title = displayTitle;
    image.dataset.markdownSrc = src;
    // Cap to the container but don't force up to the drag minimum — an
    // auto-fitted tall image may legitimately be narrower than MIN_IMAGE_WIDTH.
    dom.style.width = width ? `${Math.min(getMaxImageWidth(dom), width)}px` : "";
    dom.dataset.resized = width ? "true" : "false";
  }

  sync(node);

  function selectImage() {
    const pos = getPos();
    if (pos == null) return;
    const selection = NodeSelection.create(view.state.doc, pos);
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
  }

  function applyWidth(width: number) {
    const pos = getPos();
    if (pos == null) return;
    const title = String(currentNode.attrs.title ?? "");
    const nextTitle = setImageWidthTitle(title, clampImageWidth(width, dom));
    const nextAttrs = { ...currentNode.attrs, title: nextTitle };
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, nextAttrs).scrollIntoView());
  }

  image.addEventListener("mousedown", (event) => {
    event.preventDefault();
    selectImage();
  });

  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectImage();

    const zoom = getEditorZoom(dom);
    const startX = event.clientX;
    const startWidth = dom.getBoundingClientRect().width / zoom;
    let nextWidth = startWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      nextWidth = clampImageWidth(startWidth + (moveEvent.clientX - startX) / zoom, dom);
      dom.style.width = `${nextWidth}px`;
      dom.dataset.resized = "true";
    };

    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      applyWidth(nextWidth);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  });

  return {
    dom,
    update: (nextNode) => {
      if (nextNode.type.name !== "image") return false;
      sync(nextNode);
      return true;
    },
    selectNode: () => dom.classList.add("milkdown-image-selected"),
    deselectNode: () => dom.classList.remove("milkdown-image-selected"),
    ignoreMutation: () => true,
  };
}

function historyPlugin() {
  return $prose(() => history());
}

function historyKeymapPlugin() {
  return $prose(() =>
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
    }),
  );
}

function imageNodeViewPlugin(imageBaseDir?: string | null) {
  return $prose(
    () =>
      new Plugin({
        props: {
          nodeViews: {
            image: ((node, view, getPos) =>
              createImageNodeView(node, view, getPos, imageBaseDir)) as NodeViewConstructor,
          },
        },
      }),
  );
}

const MilkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  (
    {
      value,
      noteId,
      imageBaseDir,
      zoom,
      placeholder,
      onChange,
      onDirty,
      onEnsureNoteSaved,
      onError,
      t,
    },
    ref,
  ) => {
    const latestValueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const onDirtyRef = useRef(onDirty);
    const onErrorRef = useRef(onError);
    const onEnsureNoteSavedRef = useRef(onEnsureNoteSaved);
    const tRef = useRef(t);
    const processingRef = useRef(false);
    const [isFocused, setIsFocused] = useState(false);

    useEffect(() => {
      onChangeRef.current = onChange;
      onDirtyRef.current = onDirty;
      onErrorRef.current = onError;
      onEnsureNoteSavedRef.current = onEnsureNoteSaved;
      tRef.current = t;
    }, [onChange, onDirty, onEnsureNoteSaved, onError, t]);

    const { get } = useEditor(
      (root) =>
        Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, latestValueRef.current);
            ctx
              .get(listenerCtx)
              .markdownUpdated((_, markdown) => {
                latestValueRef.current = markdown;
                onChangeRef.current(markdown);
                onDirtyRef.current();
              })
              .focus(() => setIsFocused(true))
              .blur(() => setIsFocused(false));
          })
          .use(commonmark)
          .use(gfm)
          .use(clipboard)
          .use(listener)
          .use(historyPlugin())
          .use(historyKeymapPlugin())
          .use(imageNodeViewPlugin(imageBaseDir)),
      [imageBaseDir],
    );

    const readMarkdown = useCallback(() => {
      const editor = get();
      if (!editor) return latestValueRef.current;
      const markdown = editor.action(getMarkdown());
      latestValueRef.current = markdown;
      return markdown;
    }, [get]);

    const insertMarkdown = useCallback(
      (markdown: string) => {
        const editor = get();
        if (!editor) return;
        editor.action(insert(markdown));
      },
      [get],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const editor = get();
          editor?.action((ctx) => ctx.get(editorViewCtx).focus());
        },
        getMarkdown: readMarkdown,
        insertMarkdown,
      }),
      [get, insertMarkdown, readMarkdown],
    );

    useEffect(() => {
      if (value === latestValueRef.current) return;
      latestValueRef.current = value;
      get()?.action(replaceAll(value, true));
    }, [get, value]);

    const processImageFiles = useCallback(
      async (files: File[]) => {
        if (processingRef.current || files.length === 0) return;
        processingRef.current = true;

        try {
          let resolvedId = noteId;
          if (!resolvedId) {
            resolvedId = await onEnsureNoteSavedRef.current();
            if (!resolvedId) return;
          }

          const editor = get();
          let maxWidth = 0;
          if (editor) {
            const viewDom = editor.action((ctx) => ctx.get(editorViewCtx).dom) as HTMLElement;
            const contentWidth = viewDom.getBoundingClientRect().width / getEditorZoom(viewDom);
            maxWidth = contentWidth * IMAGE_INSERT_WIDTH_RATIO;
          }

          const markdown = await saveImageFilesAsMarkdown(
            files,
            resolvedId,
            maxWidth > 0 ? { maxWidth } : undefined,
            tRef.current,
          );
          if (!markdown) return;

          insertMarkdown(markdown);
          onDirtyRef.current();
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : (tRef.current?.("errors.imagePasteFailed", { defaultValue: "图片粘贴失败" }) ??
                "图片粘贴失败");
          onErrorRef.current?.(message);
        } finally {
          processingRef.current = false;
        }
      },
      [insertMarkdown, noteId, get],
    );

    const handlePasteCapture = useCallback(
      (event: ClipboardEvent<HTMLDivElement>) => {
        const files = getImageFiles(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void processImageFiles(files);
      },
      [processImageFiles],
    );

    const handleDropCapture = useCallback(
      (event: DragEvent<HTMLDivElement>) => {
        const files = getImageFiles(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void processImageFiles(files);
      },
      [processImageFiles],
    );

    const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
      const hasImage = Array.from(event.dataTransfer.items).some(
        (item) => item.kind === "file" && item.type in MIME_TO_EXT,
      );
      if (!hasImage) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }, []);

    const isEmpty = latestValueRef.current.trim().length === 0;

    return (
      <div
        className="milkdown-editor-shell"
        data-empty={isEmpty ? "true" : "false"}
        data-focused={isFocused ? "true" : "false"}
        onPasteCapture={handlePasteCapture}
        onDropCapture={handleDropCapture}
        onDragOver={handleDragOver}
        style={{ "--surface-zoom": String(zoom) } as CSSProperties}
      >
        {placeholder && <div className="milkdown-placeholder">{placeholder}</div>}
        <Milkdown />
      </div>
    );
  },
);

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  (props, ref) => (
    <MilkdownProvider>
      <MilkdownEditor {...props} ref={ref} />
    </MilkdownProvider>
  ),
);
