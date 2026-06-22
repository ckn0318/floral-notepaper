import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent } from "react";
import type { TFunction } from "i18next";
import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { clipboard } from "@milkdown/plugin-clipboard";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { NodeSelection, Plugin, TextSelection } from "@milkdown/prose/state";
import type { Command } from "@milkdown/prose/state";
import { history, redo, undo } from "@milkdown/prose/history";
import { keymap } from "@milkdown/prose/keymap";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView, NodeViewConstructor } from "@milkdown/prose/view";
import { $nodeSchema, $prose, $remark, getMarkdown, insert, replaceAll } from "@milkdown/utils";
import { visit } from "unist-util-visit";
import type { Paragraph, Parent, Root } from "mdast";
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
      if (nextNode.type.name !== "image" && nextNode.type.name !== "image_block") return false;
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

/** Block-level image node. CommonMark's inline `image` node is kept (for the
 *  rare image inside a sentence); this block variant is used for stand-alone
 *  images so each image owns its own block. With the gap cursor enabled, the
 *  caret can sit cleanly between/around image blocks without an empty paragraph,
 *  so consecutive images pack tightly and Backspace removes the block instead of
 *  deleting an inline image from a shared paragraph.
 *
 *  Round-trip: the remark transform below lifts every lone-image paragraph to an
 *  `imageBlock` mdast node on parse; toMarkdown writes it back as a normal
 *  `![](...)` paragraph on save (transformers don't re-run on serialize). */
const imageBlockSchema = $nodeSchema("image_block", () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  marks: "",
  attrs: {
    src: { default: "" },
    alt: { default: "" },
    title: { default: "" },
  },
  parseDOM: [
    {
      tag: "img[data-image-block]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) throw new Error("image_block expects an element");
        return {
          src: dom.getAttribute("src") || "",
          alt: dom.getAttribute("alt") || "",
          title: dom.getAttribute("title") || "",
        };
      },
    },
  ],
  toDOM: (node) => ["img", { "data-image-block": "true", ...node.attrs }],
  parseMarkdown: {
    match: ({ type }) => type === "imageBlock",
    runner: (state, node, type) => {
      state.addNode(type, {
        src: (node.url as string) ?? "",
        alt: (node.alt as string) ?? "",
        title: (node.title as string) ?? "",
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "image_block",
    runner: (state, node) => {
      state.openNode("paragraph");
      state.addNode("image", undefined, undefined, {
        url: node.attrs.src,
        alt: node.attrs.alt,
        title: node.attrs.title || undefined,
      });
      state.closeNode();
    },
  },
}));

/** Split every paragraph that contains an image into block-level pieces: each
 *  image becomes an `imageBlock` mdast node (consumed by imageBlockSchema) and
 *  each run of non-image content becomes its own paragraph. This pulls images
 *  onto their own line — including legacy notes where text and an image were
 *  saved in a single paragraph (`![](a)text`). Parse-only — the serializer calls
 *  remark.stringify without re-running transformers, so saved markdown stays
 *  standard `![](...)`. */
const remarkImageBlock = $remark("remarkImageBlock", () => () => (tree: Root) => {
  visit(tree, "paragraph", (node: Paragraph, index, parent: Parent | undefined) => {
    if (!parent || typeof index !== "number") return undefined;
    if (!node.children.some((child) => child.type === "image")) return undefined;

    const replacement: unknown[] = [];
    let run: Paragraph["children"] = [];
    const flushRun = () => {
      if (run.length) {
        replacement.push({ type: "paragraph", children: run });
        run = [];
      }
    };
    for (const child of node.children) {
      if (child.type === "image") {
        flushRun();
        replacement.push({
          type: "imageBlock",
          url: child.url,
          alt: child.alt ?? "",
          title: child.title ?? "",
        });
      } else {
        run.push(child);
      }
    }
    flushRun();

    parent.children.splice(index, 1, ...(replacement as Parent["children"]));
    // Continue past the nodes we just inserted (none are image-bearing
    // paragraphs, so there is nothing left to split here).
    return index + replacement.length;
  });
});

/** ArrowUp/ArrowDown from the edge line of a text block selects the adjacent
 *  image block (blue node selection, no caret) instead of moving the caret past
 *  it. Block atoms are selected this way (the macOS-notes-style behavior the
 *  user expects); we make it explicit rather than relying on the browser. */
function selectAdjacentImageBlock(dir: "up" | "down"): Command {
  return (state, dispatch, view) => {
    const { selection } = state;
    if (!selection.empty) return false;
    const $side = dir === "up" ? selection.$from : selection.$to;
    if ($side.depth < 1) return false;

    // Fire only when the caret is on the edge line toward `dir`. The robust
    // signal is the content edge (caret at the very start/end of its block);
    // endOfTextblock is a DOM-measurement fallback for multi-line blocks where
    // the caret sits on the edge line but not at its very start/end (it can
    // misreport, so it must not be the sole gate).
    const atContentEdge =
      dir === "up" ? $side.parentOffset === 0 : $side.parentOffset === $side.parent.content.size;
    if (!atContentEdge && view && !view.endOfTextblock(dir)) return false;

    const boundary = dir === "up" ? $side.before(1) : $side.after(1);
    const $boundary = state.doc.resolve(boundary);
    const target = dir === "up" ? $boundary.nodeBefore : $boundary.nodeAfter;
    if (target?.type.name !== "image_block") return false;
    const targetPos = dir === "up" ? boundary - target.nodeSize : boundary;

    dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, targetPos)).scrollIntoView());
    return true;
  };
}

/** Backspace in an empty paragraph adjacent to an image block removes that blank
 *  line and selects the image, instead of the default (which would delete the
 *  image, or — at the document start — do nothing). Handles both the line right
 *  after an image and a leading blank line right before the first image. */
const selectImageBlockOnBackspace: Command = (state, dispatch) => {
  const { selection } = state;
  if (!selection.empty) return false;
  const $cursor = selection.$from;
  if ($cursor.depth !== 1) return false;
  const parent = $cursor.parent;
  if (parent.type.name !== "paragraph" || parent.content.size !== 0) return false;

  const before = $cursor.before(1);
  const after = $cursor.after(1);
  const prev = state.doc.resolve(before).nodeBefore;
  const next = state.doc.resolve(after).nodeAfter;

  // Blank line directly after an image → remove it, select that image.
  if (prev?.type.name === "image_block") {
    const tr = state.tr.delete(before, after);
    tr.setSelection(NodeSelection.create(tr.doc, before - prev.nodeSize));
    dispatch?.(tr.scrollIntoView());
    return true;
  }
  // Leading blank line directly before the first image → remove it, select it.
  if (before === 0 && next?.type.name === "image_block") {
    const tr = state.tr.delete(before, after);
    tr.setSelection(NodeSelection.create(tr.doc, 0));
    dispatch?.(tr.scrollIntoView());
    return true;
  }
  return false;
};

/** Enter while an image block is selected moves the caret to the line below it
 *  (creating one if needed), like ArrowDown. The default (createParagraphNear)
 *  inserts a paragraph *before* a selected first node, which would push a blank
 *  line above the image. */
const moveCaretBelowSelectedImageBlock: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image_block") return false;
  const after = sel.to;
  let tr = state.tr;
  if (state.doc.resolve(after).nodeAfter?.type.name !== "paragraph") {
    const empty = state.schema.nodes.paragraph?.createAndFill();
    if (!empty) return false;
    tr = tr.insert(after, empty);
  }
  tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
  dispatch?.(tr.scrollIntoView());
  return true;
};

function imageBlockKeymapPlugin() {
  return $prose(() =>
    keymap({
      ArrowUp: selectAdjacentImageBlock("up"),
      ArrowDown: selectAdjacentImageBlock("down"),
      Backspace: selectImageBlockOnBackspace,
      Enter: moveCaretBelowSelectedImageBlock,
    }),
  );
}

/** Hide the text caret while a node (image block) is selected, so a selected
 *  image shows only its blue outline — no stray caret on the line below it. */
function hideCaretOnNodeSelectionPlugin() {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update: (view) => {
            view.dom.classList.toggle(
              "node-selected",
              view.state.selection instanceof NodeSelection,
            );
          },
        }),
      }),
  );
}

/** Ensure the document always ends with a paragraph, so the caret has a place to
 *  land after a trailing image block (an atom you can select but not type into).
 *  Without this, a note ending in an image would trap the caret. */
function trailingParagraphPlugin() {
  return $prose(
    () =>
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (state.doc.lastChild?.type.name !== "image_block") return null;
          const empty = state.schema.nodes.paragraph?.createAndFill();
          if (!empty) return null;
          return state.tr.insert(state.doc.content.size, empty);
        },
      }),
  );
}

function imageNodeViewPlugin(imageBaseDir?: string | null) {
  const view = ((node, editorView, getPos) =>
    createImageNodeView(node, editorView, getPos, imageBaseDir)) as NodeViewConstructor;
  return $prose(
    () =>
      new Plugin({
        props: {
          nodeViews: { image: view, image_block: view },
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
          .use(remarkImageBlock)
          .use(imageBlockSchema)
          .use(historyPlugin())
          .use(historyKeymapPlugin())
          .use(imageBlockKeymapPlugin())
          .use(trailingParagraphPlugin())
          .use(hideCaretOnNodeSelectionPlugin())
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
