import fs from "node:fs";
import path from "node:path";
import { newId } from "./store/db.js";

export const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const MAX_IMAGES_PER_MESSAGE = 5;
/** Max decoded bytes per image. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface IncomingImage {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface StoredImageRef {
  id: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
}

export interface PromptImage {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function stripDataUrl(data: string): { mimeType?: string; base64: string } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(data.trim());
  if (m) return { mimeType: m[1], base64: m[2] };
  return { base64: data.trim() };
}

function approxDecodedBytes(base64: string): number {
  const cleaned = base64.replace(/\s/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

export function validateIncomingImages(
  images: IncomingImage[] | undefined,
): { ok: true; images: PromptImage[] } | { ok: false; error: string } {
  if (!images?.length) return { ok: true, images: [] };
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message`,
    };
  }

  const out: PromptImage[] = [];
  for (const raw of images) {
    if (!raw || typeof raw.data !== "string" || !raw.data.trim()) {
      return { ok: false, error: "each image requires base64 data" };
    }
    const stripped = stripDataUrl(raw.data);
    const mimeType = (raw.mimeType || stripped.mimeType || "").toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
      return {
        ok: false,
        error: `unsupported image type: ${mimeType || "(missing)"}; allowed: png, jpeg, gif, webp`,
      };
    }
    const byteLength = approxDecodedBytes(stripped.base64);
    if (byteLength <= 0) {
      return { ok: false, error: "image data is empty or invalid" };
    }
    if (byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `each image must be ≤ ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`,
      };
    }
    const img: PromptImage = { data: stripped.base64, mimeType };
    if (typeof raw.width === "number" && typeof raw.height === "number") {
      img.width = raw.width;
      img.height = raw.height;
    }
    out.push(img);
  }
  return { ok: true, images: out };
}

export function uploadsRoot(dataDir: string): string {
  return path.join(dataDir, "uploads");
}

export function saveTaskImages(
  dataDir: string,
  taskId: string,
  images: PromptImage[],
): StoredImageRef[] {
  if (!images.length) return [];
  const dir = path.join(uploadsRoot(dataDir), taskId);
  fs.mkdirSync(dir, { recursive: true });

  return images.map((img) => {
    const id = newId("img");
    const ext = EXT[img.mimeType] || "bin";
    const filePath = path.join(dir, `${id}.${ext}`);
    const buf = Buffer.from(img.data, "base64");
    fs.writeFileSync(filePath, buf);
    const ref: StoredImageRef = {
      id,
      mimeType: img.mimeType,
      byteLength: buf.byteLength,
    };
    if (img.width != null) ref.width = img.width;
    if (img.height != null) ref.height = img.height;
    return ref;
  });
}

function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function resolveAttachmentPath(
  dataDir: string,
  taskId: string,
  attachmentId: string,
): { filePath: string; mimeType: string } | undefined {
  if (!isSafeId(taskId) || !isSafeId(attachmentId)) return undefined;

  const dir = path.join(uploadsRoot(dataDir), taskId);
  if (!fs.existsSync(dir)) return undefined;

  for (const [mime, ext] of Object.entries(EXT)) {
    const filePath = path.join(dir, `${attachmentId}.${ext}`);
    if (fs.existsSync(filePath)) {
      return { filePath, mimeType: mime };
    }
  }
  return undefined;
}
