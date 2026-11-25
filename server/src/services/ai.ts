/**
 * AI integration. All provider calls happen on the server - API keys never
 * reach the browser. When no key is configured the functions return clearly
 * labeled simulated ("Demo Mode") results.
 *
 * Privacy: prompts only contain lesson content, images of the robot and
 * aggregated learning metrics. Student names are never sent.
 */
import fsp from "node:fs/promises";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http.js";
import { getAiSettings, keyConfigured } from "./settings.js";

export type Lang = "th" | "en";

export class AiUnavailableError extends HttpError {
  constructor(message = "AI service is temporarily unavailable") {
    super(503, message, "AI_UNAVAILABLE");
  }
}

type ImagePart = { mime: string; base64: string };
type ChatTurn = { role: "user" | "assistant"; content: string };

export type AiMode = { demo: boolean; provider: "openai" | "gemini" | "demo"; model: string };

export async function resolveMode(): Promise<AiMode> {
  const s = await getAiSettings();
  if (!s.enabled) throw new HttpError(503, "AI features are turned off by the administrator", "AI_DISABLED");
  if (s.forceDemo || !keyConfigured(s.provider)) return { demo: true, provider: "demo", model: "simulated" };
  return { demo: false, provider: s.provider, model: s.provider === "openai" ? env.openaiModel : env.geminiModel };
}

/** Per-group daily limit across inspections and chat. */
export async function checkDailyLimit(groupId: string) {
  const s = await getAiSettings();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const used = await prisma.learningAnalytics.count({
    where: { groupId, type: { in: ["AI_ANALYSIS", "AI_CHAT"] }, createdAt: { gte: since } },
  });
  if (used >= s.dailyLimitPerGroup) {
    throw new HttpError(429, "Your group has reached today's AI limit. Please ask your teacher.", "AI_LIMIT");
  }
}

async function readImage(absPath: string, mime: string): Promise<ImagePart> {
  return { mime, base64: (await fsp.readFile(absPath)).toString("base64") };
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

async function callOpenAI(opts: { model: string; system: string; turns: ChatTurn[]; images?: ImagePart[]; json: boolean }) {
  const messages: unknown[] = [{ role: "system", content: opts.system }];
  opts.turns.forEach((t, i) => {
    const isLastUser = i === opts.turns.length - 1 && t.role === "user";
    if (isLastUser && opts.images?.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: t.content },
          ...opts.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
        ],
      });
    } else messages.push({ role: t.role, content: t.content });
  });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.openaiKey}` },
    body: JSON.stringify({
      model: opts.model,
      messages,
      temperature: 0.4,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new AiUnavailableError(`OpenAI error ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new AiUnavailableError("Empty response from OpenAI");
  return out;
}

async function callGemini(opts: { model: string; system: string; turns: ChatTurn[]; images?: ImagePart[]; json: boolean }) {
  const contents = opts.turns.map((t, i) => {
    const parts: unknown[] = [{ text: t.content }];
    if (i === opts.turns.length - 1 && t.role === "user" && opts.images?.length) {
      for (const img of opts.images) parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    }
    return { role: t.role === "assistant" ? "model" : "user", parts };
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        generationConfig: { temperature: 0.4, ...(opts.json ? { responseMimeType: "application/json" } : {}) },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) throw new AiUnavailableError(`Gemini error ${res.status}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!out) throw new AiUnavailableError("Empty response from Gemini");
  return out;
}

async function callModel(mode: AiMode, opts: { system: string; turns: ChatTurn[]; images?: ImagePart[]; json: boolean }) {
  try {
    if (mode.provider === "openai") return await callOpenAI({ model: mode.model, ...opts });
    if (mode.provider === "gemini") return await callGemini({ model: mode.model, ...opts });
  } catch (e) {
    if (e instanceof AiUnavailableError) throw e;
    throw new AiUnavailableError(e instanceof Error && e.name === "TimeoutError" ? "AI request timed out" : undefined);
  }
  throw new AiUnavailableError("No AI provider configured");
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new AiUnavailableError("AI returned an unreadable answer");
  }
}

const langName = (lang: Lang) => (lang === "th" ? "Thai (ภาษาไทย)" : "English");

// ---------------------------------------------------------------------------
// AI Robot Inspector
// ---------------------------------------------------------------------------

const list = z.array(z.string()).catch([]);
export const inspectionSchema = z.object({
  summary: z.string().catch(""),
  strengths: list,
  possibleIssues: list,
  missingParts: list,
  suggestions: list,
  thinkingQuestions: list,
  limitations: list,
  needsBetterPhoto: z.boolean().catch(false),
});
export type Inspection = z.infer<typeof inspectionSchema>;

export type InspectContext = {
  lessonTitle: string;
  missionTitle?: string;
  missionDescription?: string;
  successCriteria: string[];
  materials: string[];
  attempt: number;
  studentNote?: string;
  lang: Lang;
};

function inspectorSystemPrompt(lang: Lang) {
  return `You are "Robot Inspector", a friendly robotics coach for school students (age 10-15).
You look at a PHOTO of the students' robot and, when provided, a PHOTO of the teacher's prototype robot.

Rules you MUST follow:
- Only comment on what is VISIBLE in the photo (structure, parts, wiring that can be seen, sensor placement).
- NEVER claim that the circuit, the code, or the robot's real behaviour is correct or incorrect from a photo alone. Say what should be TESTED instead.
- If the photo is blurry, too dark, too far, or the robot is not fully visible, set "needsBetterPhoto": true and explain what photo to take (angle, distance, light).
- Do NOT give the full solution. Give hints and guiding questions so students think for themselves.
- Use simple, encouraging language suitable for students. Short sentences.
- You are an assistant, not a grader. Do not give scores.
- Write every text field in ${langName(lang)}.

Reply with ONLY a JSON object with exactly these keys:
{
  "summary": string (1-2 sentences),
  "strengths": string[] (what looks good),
  "possibleIssues": string[] (parts that MAY not be right yet - use "may/might"),
  "missingParts": string[] (parts that may be missing compared with the prototype / material list),
  "suggestions": string[] (concrete next steps to improve, as hints),
  "thinkingQuestions": string[] (2-3 questions that make students think),
  "limitations": string[] (what cannot be judged from this photo, e.g. code, wiring behind parts, motor direction),
  "needsBetterPhoto": boolean
}`;
}

function inspectorUserPrompt(ctx: InspectContext, hasPrototype: boolean) {
  return [
    `Lesson: ${ctx.lessonTitle}`,
    ctx.missionTitle ? `Mission: ${ctx.missionTitle}` : "",
    ctx.missionDescription ? `Mission details: ${ctx.missionDescription}` : "",
    ctx.successCriteria.length ? `Success criteria:\n- ${ctx.successCriteria.join("\n- ")}` : "",
    ctx.materials.length ? `Expected materials:\n- ${ctx.materials.join("\n- ")}` : "",
    `This is attempt number ${ctx.attempt}.`,
    ctx.studentNote ? `Students' note: "${ctx.studentNote.slice(0, 500)}"` : "",
    hasPrototype
      ? "Image 1 is the students' robot. Image 2 is the teacher's prototype for reference."
      : "The image is the students' robot. No prototype photo is available.",
  ]
    .filter(Boolean)
    .join("\n");
}

function demoInspection(ctx: InspectContext): Inspection {
  const th = ctx.lang === "th";
  const crit = ctx.successCriteria;
  return {
    summary: th
      ? `[ผลจำลอง Demo Mode] ระบบยังไม่ได้เชื่อมต่อ AI จริง นี่คือตัวอย่างรูปแบบคำแนะนำสำหรับครั้งที่ ${ctx.attempt}`
      : `[Simulated - Demo Mode] No real AI is connected. This is an example of the feedback format for attempt ${ctx.attempt}.`,
    strengths: th
      ? ["มองเห็นโครงสร้างหลักของหุ่นยนต์ในภาพ", "ภาพถ่ายช่วยให้ครูเห็นความคืบหน้าของกลุ่ม"]
      : ["The main robot structure is visible in the photo", "The photo helps your teacher follow your progress"],
    possibleIssues: crit.slice(0, 2).map((c) => (th ? `ลองตรวจสอบอีกครั้งว่า "${c}" แล้วหรือยัง` : `Double-check whether "${c}" is done`)),
    missingParts: ctx.materials.slice(0, 2).map((m) => (th ? `ตรวจดูว่าใช้ "${m}" ครบตามรายการหรือไม่` : `Check that "${m}" is installed`)),
    suggestions: th
      ? ["ถ่ายภาพจากด้านบนและด้านข้างให้เห็นการต่อสายชัดเจน", "เปรียบเทียบกับภาพหุ่นยนต์ต้นแบบทีละส่วน", "ทดสอบการทำงานจริงและจดบันทึกผล"]
      : ["Take photos from the top and the side so wiring is clear", "Compare with the prototype part by part", "Run a real test and write down the result"],
    thinkingQuestions: th
      ? ["ถ้าหุ่นยนต์ไม่ทำงานตามที่คาด ส่วนไหนควรตรวจสอบก่อน เพราะอะไร?", "มีวิธีทำให้หุ่นยนต์มั่นคงขึ้นได้อย่างไร?"]
      : ["If the robot does not behave as expected, which part would you check first and why?", "How could you make the robot more stable?"],
    limitations: th
      ? ["นี่เป็นผลจำลอง ไม่ได้วิเคราะห์ภาพจริง", "AI ไม่สามารถยืนยันความถูกต้องของวงจรหรือโค้ดจากภาพถ่ายได้ ต้องทดสอบจริง"]
      : ["This is a simulated result - the photo was not analysed", "AI cannot confirm the circuit or code from a photo; run a real test"],
    needsBetterPhoto: false,
  };
}

export async function inspectRobot(
  ctx: InspectContext,
  image: { absPath: string; mime: string },
  prototype?: { absPath: string; mime: string } | null,
): Promise<{ mode: AiMode; result: Inspection }> {
  const mode = await resolveMode();
  if (mode.demo) {
    await new Promise((r) => setTimeout(r, 600)); // keep the loading state visible in demos
    return { mode, result: demoInspection(ctx) };
  }
  const images = [await readImage(image.absPath, image.mime)];
  if (prototype) images.push(await readImage(prototype.absPath, prototype.mime));
  const raw = await callModel(mode, {
    system: inspectorSystemPrompt(ctx.lang),
    turns: [{ role: "user", content: inspectorUserPrompt(ctx, !!prototype) }],
    images,
    json: true,
  });
  return { mode, result: inspectionSchema.parse(extractJson(raw)) };
}

// ---------------------------------------------------------------------------
// AI Learning Assistant (chat)
// ---------------------------------------------------------------------------

export type AssistantContext = {
  lessonTitle: string;
  unitName: string;
  objectives: string[];
  currentStep?: { phase: string; title: string; content: string };
  missionTitle?: string;
  sampleCode?: string | null;
  /** 1 = small hint, 2 = bigger hint, 3 = explain the concept (still no full solution). */
  hintLevel: 1 | 2 | 3;
  lang: Lang;
};

function assistantSystemPrompt(ctx: AssistantContext) {
  const hint = {
    1: "Give only a SMALL hint (one idea) and ask a question back.",
    2: "Give a clearer hint with an example of the idea, but not the final answer.",
    3: "Explain the concept step by step with a small generic example. Still do not write the complete solution for the mission.",
  }[ctx.hintLevel];
  return `You are "Robo Buddy", a patient robotics learning assistant for school students working in a group on an iPad.
Answer in ${langName(ctx.lang)}. Keep answers short (max ~120 words), friendly and easy to read. Use short bullet points when helpful.

Teaching rules:
- Base your answers on the CURRENT LESSON below. If a question is unrelated to robotics/coding/the lesson, kindly steer back.
- Never give the full solution or complete code for the mission. Guide with hints and questions.
- ${hint}
- Encourage testing, observing and improving. End with one short question that makes them think.
- You cannot see their robot or run their code; say so if they ask you to check it, and suggest using the Robot Inspector or testing.
- Never ask for personal information.

CURRENT LESSON
Unit: ${ctx.unitName}
Lesson: ${ctx.lessonTitle}
Objectives: ${ctx.objectives.join("; ")}
${ctx.missionTitle ? `Mission: ${ctx.missionTitle}` : ""}
${ctx.currentStep ? `Current step (${ctx.currentStep.phase}): ${ctx.currentStep.title}\n${ctx.currentStep.content.slice(0, 1500)}` : ""}
${ctx.sampleCode ? `Example code from the lesson (for reference, do not just copy it to them):\n${ctx.sampleCode.slice(0, 1500)}` : ""}`;
}

function demoAnswer(ctx: AssistantContext, question: string) {
  const th = ctx.lang === "th";
  const step = ctx.currentStep ? `${ctx.currentStep.phase} - ${ctx.currentStep.title}` : ctx.lessonTitle;
  return th
    ? `[ผลจำลอง Demo Mode — ยังไม่ได้เชื่อมต่อ AI จริง]\n\nคำถามของกลุ่ม: "${question.slice(0, 120)}"\n\nคำใบ้ระดับ ${ctx.hintLevel}: ลองกลับไปอ่านขั้นตอน "${step}" อีกครั้ง แล้วแบ่งปัญหาออกเป็นส่วนเล็ก ๆ ทดสอบทีละส่วน\n\nคำถามชวนคิด: ถ้าเปลี่ยนค่าเพียงหนึ่งอย่าง หุ่นยนต์จะทำงานต่างไปอย่างไร?`
    : `[Simulated - Demo Mode, no real AI connected]\n\nYour question: "${question.slice(0, 120)}"\n\nHint level ${ctx.hintLevel}: Re-read the step "${step}" and split the problem into small parts. Test one part at a time.\n\nThink about it: if you change only one value, how will the robot behave differently?`;
}

export async function askAssistant(ctx: AssistantContext, turns: ChatTurn[]) {
  const s = await getAiSettings();
  if (!s.chatEnabled) throw new HttpError(503, "The AI assistant is turned off by the administrator", "AI_DISABLED");
  const mode = await resolveMode();
  const last = turns[turns.length - 1]?.content ?? "";
  if (mode.demo) return { mode, answer: demoAnswer(ctx, last) };
  const answer = await callModel(mode, { system: assistantSystemPrompt(ctx), turns: turns.slice(-10), json: false });
  return { mode, answer: answer.trim() };
}

// ---------------------------------------------------------------------------
// Assessment observations (for the teacher - never a score)
// ---------------------------------------------------------------------------

export type GroupMetrics = {
  lessonTitle: string;
  stepsCompleted: number;
  totalSteps: number;
  minutesSpent: number;
  submissions: number;
  improvements: number;
  helpRequests: { category: string }[];
  aiFindings: string[];
  reflectionAnswers: string[];
  criteria: string[];
};

export async function assessmentObservations(m: GroupMetrics, lang: Lang) {
  const mode = await resolveMode();
  const th = lang === "th";
  if (mode.demo) {
    const lines = th
      ? [
          "[ข้อสังเกตจำลอง Demo Mode — ครูต้องเป็นผู้ประเมินและยืนยันคะแนน]",
          `• ทำขั้นตอนเสร็จ ${m.stepsCompleted}/${m.totalSteps} ขั้น ใช้เวลาประมาณ ${m.minutesSpent} นาที`,
          `• ส่งผลงาน ${m.submissions} ครั้ง ปรับปรุง ${m.improvements} ครั้ง — สะท้อนกระบวนการ Test/Improve`,
          `• ขอความช่วยเหลือ ${m.helpRequests.length} ครั้ง`,
          "• ควรสังเกตการมีส่วนร่วมของสมาชิกแต่ละคนในห้องเรียนประกอบ เพราะข้อมูลนี้เป็นระดับกลุ่ม",
        ]
      : [
          "[Simulated observations - Demo Mode. The teacher decides and confirms all scores]",
          `• Completed ${m.stepsCompleted}/${m.totalSteps} steps in about ${m.minutesSpent} minutes`,
          `• ${m.submissions} submissions, ${m.improvements} improvements - shows Test/Improve cycles`,
          `• ${m.helpRequests.length} help requests`,
          "• These are group-level data; observe each member's contribution in class as well",
        ];
    return { mode, text: lines.join("\n") };
  }
  const system = `You help a robotics teacher by writing short OBSERVATIONS about a student group's learning process, based only on the data given.
Rules: Do not give scores or grades. Do not judge individual students (data is group-level). Mention evidence for each criterion where available and what the teacher should observe directly. Max 120 words, bullet points, in ${langName(lang)}.`;
  const user = `Data (JSON): ${JSON.stringify(m)}`;
  const out = await callModel(mode, { system, turns: [{ role: "user", content: user }], json: false });
  return { mode, text: out.trim() };
}
