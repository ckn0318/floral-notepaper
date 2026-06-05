import { useCallback, useRef } from "react";
import type { TFunction } from "i18next";
import { saveImage } from "./api";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

interface UseImagePasteOptions {
  noteId: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: (content: string) => void;
  markDirty: () => void;
  onEnsureNoteSaved: () => Promise<string | null>;
  disabled?: boolean;
  onError?: (message: string) => void;
  t?: TFunction;
}

async function imageFileToPngData(file: File): Promise<number[]> {
  if (file.type === "image/png") {
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  }

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas context unavailable");
    context.drawImage(bitmap, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("png conversion failed");
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}

async function processImageFile(file: File, noteId: string, t?: TFunction): Promise<string | null> {
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(
      t?.("errors.imageTooLarge", { defaultValue: "图片文件过大（上限 5 MB）" }) ??
        "图片文件过大（上限 5 MB）",
    );
  }

  if (!isSupportedImageFile(file)) return null;

  const data = await imageFileToPngData(file);
  return saveImage(noteId, data, "png");
}

function insertTextAtCursor(
  textarea: HTMLTextAreaElement,
  setContent: (value: string) => void,
  text: string,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const insertion = (needsLeadingNewline ? "\n" : "") + text + "\n";
  const newContent = before + insertion + after;
  setContent(newContent);

  requestAnimationFrame(() => {
    const newPos = before.length + insertion.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
  });
}

function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file && isSupportedImageFile(file)) files.push(file);
    }
  }
  return files;
}

function isSupportedImageFile(file: File): boolean {
  if (SUPPORTED_IMAGE_TYPES.has(file.type)) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

export function useImagePaste({
  noteId,
  textareaRef,
  setContent,
  markDirty,
  onEnsureNoteSaved,
  disabled,
  onError,
  t,
}: UseImagePasteOptions) {
  const processingRef = useRef(false);

  const processFiles = useCallback(
    async (files: File[]) => {
      if (processingRef.current || files.length === 0) return;
      processingRef.current = true;

      try {
        let resolvedId = noteId;
        if (!resolvedId) {
          resolvedId = await onEnsureNoteSaved();
          if (!resolvedId) return;
        }

        const textarea = textareaRef.current;
        if (!textarea) return;

        const relativePath = await processImageFile(files[0], resolvedId, t);
        if (relativePath) {
          insertTextAtCursor(textarea, setContent, `![](${relativePath})`);
          markDirty();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (t?.("errors.imagePasteFailed", { defaultValue: "图片粘贴失败" }) ?? "图片粘贴失败");
        onError?.(message);
      } finally {
        processingRef.current = false;
      }
    },
    [noteId, textareaRef, setContent, markDirty, onEnsureNoteSaved, onError, t],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = getImageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, processFiles],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = getImageFiles(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, processFiles],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const hasImage = Array.from(event.dataTransfer.items).some(
        (item) => item.kind === "file" && SUPPORTED_IMAGE_TYPES.has(item.type),
      );
      if (hasImage) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [disabled],
  );

  return { handlePaste, handleDrop, handleDragOver };
}
