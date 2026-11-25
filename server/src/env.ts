import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable ${name} (see server/.env.example)`);
  return v;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: isProd ? required("JWT_SECRET") : required("JWT_SECRET", "dev-only-insecure-secret"),
  aiProvider: (process.env.AI_PROVIDER ?? "gemini") as "openai" | "gemini",
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 8) * 1024 * 1024,
  /** server/uploads - works for both `src` (tsx) and `dist` (compiled). */
  uploadDir: process.env.UPLOAD_DIR ?? path.resolve(here, "..", "uploads"),
};
