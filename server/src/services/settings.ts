import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { parseJson } from "../lib/http.js";

export const aiSettingsSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  enabled: z.boolean(),
  chatEnabled: z.boolean(),
  /** Max AI calls (inspections + chat messages) per group per day. */
  dailyLimitPerGroup: z.number().int().min(1).max(1000),
  /** Force demo mode even when a key is configured (useful for rehearsals). */
  forceDemo: z.boolean(),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

const DEFAULT_AI: AiSettings = {
  provider: env.aiProvider,
  enabled: true,
  chatEnabled: true,
  dailyLimitPerGroup: 60,
  forceDemo: false,
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row ? { ...fallback, ...parseJson<Partial<T>>(row.value, {}) } : fallback;
}

export async function setSetting(key: string, value: unknown) {
  const v = JSON.stringify(value);
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

export async function getAiSettings(): Promise<AiSettings> {
  return getSetting("ai", DEFAULT_AI);
}

export function keyConfigured(provider: "openai" | "gemini") {
  return provider === "openai" ? !!env.openaiKey : !!env.geminiKey;
}
