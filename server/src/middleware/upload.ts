import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import type { Request } from "express";
import { env } from "../env.js";
import { badRequest } from "../lib/http.js";

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // some browsers send this for .xlsx
]);

export type UploadKind = "submissions" | "lessons";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Image upload (jpg/png/webp), stored under uploads/<kind>/ with a random name. */
export function imageUpload(kind: UploadKind) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, ensureDir(path.join(env.uploadDir, kind))),
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${IMAGE_TYPES[file.mimetype] ?? ""}`),
    }),
    limits: { fileSize: env.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) cb(null, true);
      else cb(badRequest("Only JPG, PNG or WEBP images are allowed"));
    },
  }).single("image");
}

/** In-memory upload for Excel imports (max 2 MB). */
export const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (XLSX_TYPES.has(file.mimetype) && file.originalname.toLowerCase().endsWith(".xlsx")) cb(null, true);
    else cb(badRequest("Please upload an .xlsx file"));
  },
}).single("file");

/** Check magic bytes so a renamed non-image cannot slip through the MIME check. */
export async function verifyImageFile(req: Request): Promise<{ url: string; absPath: string; mime: string }> {
  const f = req.file;
  if (!f) throw badRequest("No image uploaded (field name: image)");
  const fh = await fsp.open(f.path, "r");
  const buf = Buffer.alloc(12);
  await fh.read(buf, 0, 12, 0);
  await fh.close();
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    await fsp.rm(f.path, { force: true });
    throw badRequest("The file is not a valid image");
  }
  const rel = path.relative(env.uploadDir, f.path).split(path.sep).join("/");
  return { url: `/uploads/${rel}`, absPath: f.path, mime: f.mimetype };
}

/** Map a public /uploads/... URL back to a file path inside the upload dir (or null). */
export function uploadPathFromUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("/uploads/")) return null;
  const abs = path.resolve(env.uploadDir, url.slice("/uploads/".length));
  if (!abs.startsWith(path.resolve(env.uploadDir) + path.sep)) return null; // path traversal guard
  return abs;
}

export async function deleteUpload(url: string | null | undefined) {
  const p = uploadPathFromUrl(url);
  if (p) await fsp.rm(p, { force: true }).catch(() => {});
}
