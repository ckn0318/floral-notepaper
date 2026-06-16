import type { TFunction } from "i18next";
import { saveImage } from "./api";

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

export const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export async function saveImageFile(
  file: File,
  noteId: string,
  t?: TFunction,
): Promise<string | null> {
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(
      t?.("errors.imageTooLarge", { defaultValue: "图片文件过大（上限 20 MB）" }) ??
        "图片文件过大（上限 20 MB）",
    );
  }

  const ext = MIME_TO_EXT[file.type];
  if (!ext) return null;

  const buffer = await file.arrayBuffer();
  const data = Array.from(new Uint8Array(buffer));
  return saveImage(noteId, data, ext);
}

export function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.kind === "file" && item.type in MIME_TO_EXT) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export async function saveImageFilesAsMarkdown(
  files: File[],
  noteId: string,
  t?: TFunction,
): Promise<string> {
  const markdownLines: string[] = [];
  for (const file of files) {
    const relativePath = await saveImageFile(file, noteId, t);
    if (relativePath) markdownLines.push(`![](${relativePath})`);
  }
  return markdownLines.join("\n");
}
