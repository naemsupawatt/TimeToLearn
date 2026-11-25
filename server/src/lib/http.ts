import type { Request } from "express";
import { z, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "BAD_REQUEST", details);
export const unauthorized = (msg = "Authentication required") => new HttpError(401, msg, "UNAUTHORIZED");
export const forbidden = (msg = "You do not have permission to do this") => new HttpError(403, msg, "FORBIDDEN");
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`, "NOT_FOUND");
export const conflict = (msg: string) => new HttpError(409, msg, "CONFLICT");

/** Parse and validate input. Throws a 400 with field errors on failure. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest("Invalid input", r.error.flatten());
  }
  return r.data;
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || !v) throw badRequest(`Missing parameter ${name}`);
  return v;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Trimmed, length-limited string. Text is always rendered as plain text by the
 * web client (no HTML), so we do not need to HTML-escape on the way in. */
export const text = (max = 2000) => z.string().trim().max(max);
export const reqText = (max = 200) => z.string().trim().min(1).max(max);
