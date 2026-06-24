import type { TFunction } from "i18next";
import { saveImage } from "./api";

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** Default ceiling for a freshly inserted image's display height (px). Tall
 *  images are scaled down so their height never exceeds this. Kept in sync with
 *  the --image-max-height CSS token. */
export const DEFAULT_IMAGE_MAX_HEIGHT = 180;

interface ImageFitOptions {
  /** Max display width in logical px (e.g. 85% of the editor content width). */
  maxWidth: number;
  /** Max display height in px. Defaults to DEFAULT_IMAGE_MAX_HEIGHT. */
  maxHeight?: number;
}

/** Read an image file's intrinsic pixel dimensions. Returns null for formats
 *  without a usable raster size (e.g. some SVGs) or on decode failure. */
async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** Scale (width, height) to fit within maxWidth × maxHeight, preserving aspect
 *  ratio. Returns the fitted display width, or null when the image already fits
 *  (so small images keep their natural size and no width= is baked in). */
export function fitDisplayWidth(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): number | null {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  if (scale >= 1) return null;
  return Math.max(1, Math.round(width * scale));
}

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
  fit?: ImageFitOptions,
  t?: TFunction,
): Promise<string> {
  const maxHeight = fit?.maxHeight ?? DEFAULT_IMAGE_MAX_HEIGHT;
  const markdownLines: string[] = [];
  for (const file of files) {
    const relativePath = await saveImageFile(file, noteId, t);
    if (!relativePath) continue;

    let line = `![](${relativePath})`;
    if (fit && fit.maxWidth > 0) {
      const dimensions = await getImageDimensions(file);
      if (dimensions) {
        const displayWidth = fitDisplayWidth(
          dimensions.width,
          dimensions.height,
          fit.maxWidth,
          maxHeight,
        );
        if (displayWidth != null) line = `![](${relativePath} "width=${displayWidth}")`;
      }
    }
    markdownLines.push(line);
  }
  return markdownLines.join("\n");
}
