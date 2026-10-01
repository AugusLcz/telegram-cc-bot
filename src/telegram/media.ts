import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";

/** Bots can only download files up to 20 MB through the Bot API. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function downloadFile(api: Api, token: string, fileId: string, size?: number): Promise<{ data: Buffer; filePath: string }> {
  if (size && size > MAX_DOWNLOAD) throw new Error("File exceeds the Telegram Bot API 20 MB download limit");
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), filePath: file.file_path };
}

export function imageMediaType(filePath: string) {
  return IMAGE_TYPES[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
}

/** Save an uploaded document under <cwd>/.tg-uploads/ and return its absolute path. */
export async function saveUpload(cwd: string, fileName: string, data: Buffer): Promise<string> {
  const dir = path.join(cwd, ".tg-uploads");
  await fs.mkdir(dir, { recursive: true });
  const safe = path.basename(fileName).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_") || "file";
  const target = path.join(dir, `${Date.now()}-${safe}`);
  await fs.writeFile(target, data);
  return target;
}
