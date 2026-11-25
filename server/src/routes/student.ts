import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { HttpError, parse, parseJson, reqText, text } from "../lib/http.js";
import { HELP_CATEGORIES } from "../lib/constants.js";
import { groupOf, requireGroup } from "../middleware/auth.js";
import { deleteUpload, imageUpload, uploadPathFromUrl, verifyImageFile } from "../middleware/upload.js";
import { emit, rooms } from "../realtime/socket.js";
import { activeSessionFor, buildGroupCard, displayName, ensureProgressRows, logEvent, notifyTeacher, pushGroupUpdate } from "../services/live.js";
import { AiUnavailableError, askAssistant, checkDailyLimit, inspectRobot, type Lang } from "../services/ai.js";
import { serializeLesson } from "./lessons.js";

export const studentRouter = Router();
studentRouter.use(requireGroup);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `ai:${req.auth?.id ?? "anon"}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "AI_RATE", message: "Too many AI requests. Please wait a minute." } },
});

const langOf = (req: Request): Lang => (req.headers["accept-language"]?.toString().startsWith("en") ? "en" : "th");

async function requireActiveSession(req: Request) {
  const g = groupOf(req);
  const session = await activeSessionFor(g.classroomId);
  if (!session) throw new HttpError(409, "There is no active lesson right now. Please wait for your teacher.", "NO_SESSION");
  await ensureProgressRows(session.id);
  const progress = await prisma.groupProgress.findUniqueOrThrow({ where: { sessionId_groupId: { sessionId: session.id, groupId: g.id } } });
  return { g, session, progress };
}

studentRouter.get("/home", async (req, res) => {
  const g = groupOf(req);
  const group = await prisma.group.findUniqueOrThrow({
    where: { id: g.id },
    include: { classroom: true, members: { include: { student: true } } },
  });
  const session = await activeSessionFor(g.classroomId);
  const base = {
    group: {
      id: group.id, name: group.name, color: group.color, classroom: group.classroom.name,
      members: group.members.map((m) => ({ id: m.studentId, name: displayName(m.student), role: m.role })),
    },
  };
  if (!session) return res.json({ ...base, session: null });
  await ensureProgressRows(session.id);
  const card = await buildGroupCard(session.id, g.id);
  const lesson = await prisma.lesson.findUniqueOrThrow({
    where: { id: session.lessonId },
    include: { missions: { orderBy: { order: "asc" } } },
  });
  const l = serializeLesson(lesson);
  res.json({
    ...base,
    session: { id: session.id, startedAt: session.startedAt },
    lesson: {
      id: l.id, title: l.title, unitName: l.unitName, objectives: l.objectives, durationMinutes: l.durationMinutes,
      difficulty: l.difficulty, coverImageUrl: l.coverImageUrl, missions: l.missions,
    },
    progress: card,
  });
});

studentRouter.get("/lesson", async (req, res) => {
  const { session, progress } = await requireActiveSession(req);
  const lesson = await prisma.lesson.findUniqueOrThrow({
    where: { id: session.lessonId },
    include: { steps: { orderBy: { order: "asc" } }, missions: { orderBy: { order: "asc" } } },
  });
  res.json({
    sessionId: session.id,
    lesson: serializeLesson(lesson),
    progress: {
      currentStepIndex: progress.currentStepIndex,
      completedSteps: parseJson<number[]>(progress.completedSteps, []),
      stepAnswers: parseJson<Record<string, unknown>>(progress.stepAnswers, {}),
      status: progress.status,
      startedAt: progress.startedAt,
    },
  });
});

studentRouter.post("/start", async (req, res) => {
  const { g, session, progress } = await requireActiveSession(req);
  if (!progress.startedAt) {
    await prisma.groupProgress.update({ where: { id: progress.id }, data: { startedAt: new Date(), lastActivityAt: new Date() } });
    await logEvent({ sessionId: session.id, groupId: g.id, type: "SESSION_JOIN" });
  }
  res.json(await pushGroupUpdate(session.id, g.id));
});

studentRouter.post("/progress", async (req, res) => {
  const { g, session, progress } = await requireActiveSession(req);
  const b = parse(
    z.object({
      stepIndex: z.number().int().min(0).max(200),
      action: z.enum(["visit", "complete", "save"]),
      answer: z.object({ checked: z.array(z.boolean()).max(30).optional(), answer: text(3000).optional() }).optional(),
    }),
    req.body,
  );
  const steps = await prisma.lessonStep.findMany({ where: { lessonId: session.lessonId }, orderBy: { order: "asc" } });
  const step = steps[b.stepIndex];
  if (!step) throw new HttpError(400, "Step does not exist", "BAD_STEP");

  const completed = new Set(parseJson<number[]>(progress.completedSteps, []));
  const answers = parseJson<Record<string, unknown>>(progress.stepAnswers, {});
  if (b.answer) answers[step.id] = b.answer;
  const now = new Date();
  let durationSec: number | undefined;

  if (b.action === "complete" && !completed.has(b.stepIndex)) {
    completed.add(b.stepIndex);
    const lastDone = await prisma.learningAnalytics.findFirst({
      where: { sessionId: session.id, groupId: g.id, type: "STEP_COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    const from = lastDone?.createdAt ?? progress.startedAt ?? now;
    durationSec = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
    await logEvent({ sessionId: session.id, groupId: g.id, type: "STEP_COMPLETED", stepIndex: b.stepIndex, phase: step.phase, durationSec });
    if (completed.size === steps.length) {
      await logEvent({ sessionId: session.id, groupId: g.id, type: "MISSION_COMPLETED" });
    }
  }
  const nextIndex = b.action === "complete" ? Math.min(b.stepIndex + 1, steps.length - 1) : b.stepIndex;
  await prisma.groupProgress.update({
    where: { id: progress.id },
    data: {
      currentStepIndex: nextIndex,
      completedSteps: JSON.stringify([...completed].sort((a, z2) => a - z2)),
      stepAnswers: JSON.stringify(answers),
      lastActivityAt: now,
      startedAt: progress.startedAt ?? now,
    },
  });
  const card = await pushGroupUpdate(session.id, g.id);
  res.json({ currentStepIndex: nextIndex, completedSteps: [...completed], status: card.status, durationSec });
});

// ---------------------------------------------------------------------------
// Submissions + AI Robot Inspector
// ---------------------------------------------------------------------------

studentRouter.get("/submissions", async (req, res) => {
  const { g, session } = await requireActiveSession(req);
  const subs = await prisma.submission.findMany({
    where: { sessionId: session.id, groupId: g.id },
    include: { analysis: true, mission: { select: { id: true, title: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(subs.map((s) => ({ ...s, analysis: s.analysis ? { ...s.analysis, result: parseJson(s.analysis.result, null) } : null })));
});

studentRouter.post("/submissions", aiLimiter, imageUpload("submissions"), async (req, res) => {
  const file = await verifyImageFile(req);
  let ctx: Awaited<ReturnType<typeof requireActiveSession>>;
  try {
    ctx = await requireActiveSession(req);
  } catch (e) {
    await deleteUpload(file.url); // don't keep orphaned photos
    throw e;
  }
  const { g, session, progress } = ctx;
  const b = parse(z.object({ note: text(500).optional(), missionId: z.string().optional(), analyze: z.enum(["true", "false"]).default("true") }), req.body);

  const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: session.lessonId }, include: { missions: { orderBy: { order: "asc" } } } });
  const mission = lesson.missions.find((m) => m.id === b.missionId) ?? lesson.missions[0] ?? null;
  const attempt = (await prisma.submission.count({ where: { sessionId: session.id, groupId: g.id, missionId: mission?.id ?? null } })) + 1;

  const submission = await prisma.submission.create({
    data: { sessionId: session.id, groupId: g.id, missionId: mission?.id ?? null, imageUrl: file.url, note: b.note || null, attempt },
  });
  await prisma.groupProgress.update({ where: { id: progress.id }, data: { lastActivityAt: new Date(), startedAt: progress.startedAt ?? new Date() } });
  await logEvent({ sessionId: session.id, groupId: g.id, type: "SUBMISSION", data: { attempt, submissionId: submission.id } });
  await notifyTeacher(g.classroomId, {
    type: "SUBMISSION",
    title: `${g.name}: new robot photo (attempt ${attempt})`,
    body: mission?.title ?? lesson.title,
    link: `/teacher/live?classroom=${g.classroomId}&group=${g.id}`,
  });

  let analysis = null;
  let aiError: string | null = null;
  if (b.analyze === "true") {
    try {
      await checkDailyLimit(g.id);
      const prototypePath = uploadPathFromUrl(lesson.prototypeImageUrl);
      const protoMime = lesson.prototypeImageUrl?.endsWith(".png") ? "image/png" : lesson.prototypeImageUrl?.endsWith(".webp") ? "image/webp" : "image/jpeg";
      const { mode, result } = await inspectRobot(
        {
          lessonTitle: lesson.title,
          missionTitle: mission?.title,
          missionDescription: mission?.description,
          successCriteria: parseJson<string[]>(mission?.successCriteria, []),
          materials: parseJson<string[]>(lesson.materials, []),
          attempt,
          studentNote: b.note,
          lang: langOf(req),
        },
        { absPath: file.absPath, mime: file.mime },
        prototypePath ? { absPath: prototypePath, mime: protoMime } : null,
      );
      const row = await prisma.aIAnalysis.create({
        data: { submissionId: submission.id, provider: mode.provider, model: mode.model, isDemo: mode.demo, result: JSON.stringify(result) },
      });
      analysis = { ...row, result };
      await logEvent({ sessionId: session.id, groupId: g.id, type: "AI_ANALYSIS", data: { submissionId: submission.id, demo: mode.demo, needsBetterPhoto: result.needsBetterPhoto } });
    } catch (e) {
      // The photo is still saved and the teacher can review it.
      if (e instanceof HttpError) aiError = e.message;
      else {
        console.error("[ai] inspection failed", e);
        aiError = new AiUnavailableError().message;
      }
    }
  }
  await pushGroupUpdate(session.id, g.id);
  res.status(201).json({ submission, analysis, aiError });
});

// ---------------------------------------------------------------------------
// AI Learning Assistant
// ---------------------------------------------------------------------------

studentRouter.post("/chat", aiLimiter, async (req, res) => {
  const { g, session, progress } = await requireActiveSession(req);
  const b = parse(
    z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(30),
      hintLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
      stepIndex: z.number().int().min(0).optional(),
    }),
    req.body,
  );
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Last message must be from the user");
  await checkDailyLimit(g.id);
  const lesson = await prisma.lesson.findUniqueOrThrow({
    where: { id: session.lessonId },
    include: { steps: { orderBy: { order: "asc" } }, missions: { orderBy: { order: "asc" }, take: 1 } },
  });
  const step = lesson.steps[b.stepIndex ?? progress.currentStepIndex];
  const { mode, answer } = await askAssistant(
    {
      lessonTitle: lesson.title,
      unitName: lesson.unitName,
      objectives: parseJson<string[]>(lesson.objectives, []),
      currentStep: step ? { phase: step.phase, title: step.title, content: step.content } : undefined,
      missionTitle: lesson.missions[0]?.title,
      sampleCode: lesson.sampleCode,
      hintLevel: b.hintLevel,
      lang: langOf(req),
    },
    b.messages,
  );
  await logEvent({ sessionId: session.id, groupId: g.id, type: "AI_CHAT", phase: step?.phase, data: { hintLevel: b.hintLevel, demo: mode.demo } });
  res.json({ answer, demo: mode.demo });
});

// ---------------------------------------------------------------------------
// Help requests + teacher messages
// ---------------------------------------------------------------------------

studentRouter.get("/help", async (req, res) => {
  const { g, session } = await requireActiveSession(req);
  res.json(await prisma.helpRequest.findMany({ where: { sessionId: session.id, groupId: g.id }, orderBy: { createdAt: "desc" } }));
});

studentRouter.post("/help", async (req, res) => {
  const { g, session } = await requireActiveSession(req);
  const b = parse(z.object({ category: z.enum(HELP_CATEGORIES), message: text(500).optional() }), req.body);
  const open = await prisma.helpRequest.findFirst({ where: { sessionId: session.id, groupId: g.id, status: { not: "RESOLVED" } } });
  if (open) throw new HttpError(409, "Your group already has an open help request", "HELP_OPEN");
  const h = await prisma.helpRequest.create({ data: { sessionId: session.id, groupId: g.id, category: b.category, message: b.message || null } });
  await logEvent({ sessionId: session.id, groupId: g.id, type: "HELP_REQUEST", data: { category: b.category } });
  await notifyTeacher(g.classroomId, {
    type: "HELP_REQUEST",
    title: `${g.name} needs help`,
    body: b.category + (b.message ? `: ${b.message}` : ""),
    link: `/teacher/live?classroom=${g.classroomId}&group=${g.id}`,
  });
  emit(rooms.teachers(g.classroomId), "help:new", { ...h, groupName: g.name });
  await pushGroupUpdate(session.id, g.id);
  res.status(201).json(h);
});

studentRouter.post("/help/:id/cancel", async (req, res) => {
  const { g, session } = await requireActiveSession(req);
  const h = await prisma.helpRequest.findFirst({ where: { id: String(req.params.id), groupId: g.id, sessionId: session.id } });
  if (!h) throw new HttpError(404, "Help request not found");
  const updated = await prisma.helpRequest.update({ where: { id: h.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  await pushGroupUpdate(session.id, g.id);
  res.json(updated);
});

studentRouter.get("/messages", async (req, res) => {
  const g = groupOf(req);
  res.json(await prisma.notification.findMany({ where: { groupId: g.id, type: "TEACHER_MESSAGE" }, orderBy: { createdAt: "desc" }, take: 30 }));
});

studentRouter.post("/messages/read", async (req, res) => {
  const g = groupOf(req);
  await prisma.notification.updateMany({ where: { groupId: g.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});
