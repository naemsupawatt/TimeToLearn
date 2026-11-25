import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { param, parse, parseJson, reqText, text } from "../lib/http.js";
import { DIFFICULTIES, LESSON_STATUSES, PHASES } from "../lib/constants.js";
import { ownedLesson, requireUser, userOf } from "../middleware/auth.js";
import { imageUpload, verifyImageFile } from "../middleware/upload.js";

export const lessonsRouter = Router();
lessonsRouter.use(requireUser("TEACHER", "ADMIN"));

const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || v.startsWith("/uploads/") || /^https?:\/\//i.test(v), "Must be an http(s) URL or an uploaded file")
  .nullable()
  .optional()
  .transform((v) => v || null);

const strList = (maxItems = 30, maxLen = 300) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems).default([]);

const activity = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("checklist"), items: strList(20, 200) }),
    z.object({ type: z.literal("question"), prompt: reqText(500) }),
  ])
  .default({ type: "none" });

export const lessonBody = z.object({
  unitName: reqText(120),
  title: reqText(160),
  objectives: strList(),
  durationMinutes: z.number().int().min(5).max(600).default(60),
  difficulty: z.enum(DIFFICULTIES).default("EASY"),
  materials: strList(40),
  coverImageUrl: url,
  videoUrl: url,
  prototypeImageUrl: url,
  sampleCode: text(20000).nullable().optional(),
  reflectionQuestions: strList(),
  rubricId: z.string().nullable().optional(),
  status: z.enum(LESSON_STATUSES).optional(),
  steps: z
    .array(
      z.object({
        phase: z.enum(PHASES),
        title: reqText(160),
        content: text(10000).default(""),
        imageUrl: url,
        videoUrl: url,
        activity,
      }),
    )
    .max(60)
    .default([]),
  missions: z
    .array(z.object({ title: reqText(160), description: text(3000).default(""), successCriteria: strList(20) }))
    .max(10)
    .default([]),
});

type LessonInput = z.infer<typeof lessonBody>;

function lessonData(b: LessonInput) {
  return {
    unitName: b.unitName,
    title: b.title,
    objectives: JSON.stringify(b.objectives),
    durationMinutes: b.durationMinutes,
    difficulty: b.difficulty,
    materials: JSON.stringify(b.materials),
    coverImageUrl: b.coverImageUrl,
    videoUrl: b.videoUrl,
    prototypeImageUrl: b.prototypeImageUrl,
    sampleCode: b.sampleCode ?? null,
    reflectionQuestions: JSON.stringify(b.reflectionQuestions),
    rubricId: b.rubricId ?? null,
  };
}

const childData = (b: LessonInput) => ({
  steps: {
    create: b.steps.map((s, i) => ({
      order: i, phase: s.phase, title: s.title, content: s.content, imageUrl: s.imageUrl, videoUrl: s.videoUrl,
      activity: JSON.stringify(s.activity),
    })),
  },
  missions: {
    create: b.missions.map((m, i) => ({ order: i, title: m.title, description: m.description, successCriteria: JSON.stringify(m.successCriteria) })),
  },
});

/** Serialize a lesson with its JSON columns parsed. Shared with the student API. */
export function serializeLesson<
  L extends {
    objectives: string; materials: string; reflectionQuestions: string;
    steps?: { activity: string }[]; missions?: { successCriteria: string }[];
  },
>(l: L) {
  return {
    ...l,
    objectives: parseJson<string[]>(l.objectives, []),
    materials: parseJson<string[]>(l.materials, []),
    reflectionQuestions: parseJson<string[]>(l.reflectionQuestions, []),
    steps: l.steps?.map((s) => ({ ...s, activity: parseJson(s.activity, { type: "none" }) })),
    missions: l.missions?.map((m) => ({ ...m, successCriteria: parseJson<string[]>(m.successCriteria, []) })),
  };
}

const fullInclude = {
  steps: { orderBy: { order: "asc" } },
  missions: { orderBy: { order: "asc" } },
} as const;

lessonsRouter.get("/", async (req, res) => {
  const u = userOf(req);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await prisma.lesson.findMany({
    where: { ...(u.role === "ADMIN" ? {} : { teacherId: u.id }), ...(status ? { status } : {}) },
    include: { _count: { select: { steps: true, missions: true, sessions: true } } },
    orderBy: [{ unitName: "asc" }, { updatedAt: "desc" }],
  });
  res.json(rows.map((l) => serializeLesson(l)));
});

lessonsRouter.get("/:id", async (req, res) => {
  const l = await ownedLesson(req, param(req, "id"));
  const full = await prisma.lesson.findUniqueOrThrow({ where: { id: l.id }, include: fullInclude });
  res.json(serializeLesson(full));
});

lessonsRouter.post("/", async (req, res) => {
  const u = userOf(req);
  const b = parse(lessonBody, req.body);
  const l = await prisma.lesson.create({
    data: { ...lessonData(b), status: b.status ?? "DRAFT", teacherId: u.id, ...childData(b) },
    include: fullInclude,
  });
  res.status(201).json(serializeLesson(l));
});

/** Full replace of the lesson including ordered steps and missions. */
lessonsRouter.put("/:id", async (req, res) => {
  const l = await ownedLesson(req, param(req, "id"));
  const b = parse(lessonBody, req.body);
  const inUse = await prisma.classroomSession.count({ where: { lessonId: l.id, status: "ACTIVE" } });
  const updated = await prisma.$transaction(async (tx) => {
    // Missions are referenced by submissions; keep their ids where possible.
    await tx.lessonStep.deleteMany({ where: { lessonId: l.id } });
    const oldMissions = await tx.mission.findMany({ where: { lessonId: l.id }, orderBy: { order: "asc" } });
    for (let i = 0; i < b.missions.length; i++) {
      const m = b.missions[i];
      const data = { order: i, title: m.title, description: m.description, successCriteria: JSON.stringify(m.successCriteria) };
      if (oldMissions[i]) await tx.mission.update({ where: { id: oldMissions[i].id }, data });
      else await tx.mission.create({ data: { ...data, lessonId: l.id } });
    }
    if (oldMissions.length > b.missions.length) {
      await tx.mission.deleteMany({ where: { id: { in: oldMissions.slice(b.missions.length).map((m) => m.id) } } });
    }
    return tx.lesson.update({
      where: { id: l.id },
      data: {
        ...lessonData(b),
        status: b.status ?? l.status,
        steps: childData(b).steps,
      },
      include: fullInclude,
    });
  });
  res.json({ ...serializeLesson(updated), warning: inUse ? "This lesson is being used in a live classroom" : undefined });
});

lessonsRouter.post("/:id/status", async (req, res) => {
  const l = await ownedLesson(req, param(req, "id"));
  const { status } = parse(z.object({ status: z.enum(LESSON_STATUSES) }), req.body);
  if (status === "PUBLISHED") {
    const steps = await prisma.lessonStep.count({ where: { lessonId: l.id } });
    if (!steps) return res.status(400).json({ error: { code: "NO_STEPS", message: "Add at least one step before publishing" } });
  }
  res.json(await prisma.lesson.update({ where: { id: l.id }, data: { status } }));
});

lessonsRouter.post("/:id/duplicate", async (req, res) => {
  const u = userOf(req);
  const l = await ownedLesson(req, param(req, "id"));
  const full = await prisma.lesson.findUniqueOrThrow({ where: { id: l.id }, include: fullInclude });
  const copy = await prisma.lesson.create({
    data: {
      teacherId: u.id, unitName: full.unitName, title: `${full.title} (copy)`, objectives: full.objectives,
      durationMinutes: full.durationMinutes, difficulty: full.difficulty, materials: full.materials,
      coverImageUrl: full.coverImageUrl, videoUrl: full.videoUrl, prototypeImageUrl: full.prototypeImageUrl,
      sampleCode: full.sampleCode, reflectionQuestions: full.reflectionQuestions, rubricId: full.rubricId, status: "DRAFT",
      steps: { create: full.steps.map(({ id: _i, lessonId: _l, ...s }) => s) },
      missions: { create: full.missions.map(({ id: _i, lessonId: _l, ...m }) => m) },
    },
  });
  res.status(201).json(copy);
});

lessonsRouter.delete("/:id", async (req, res) => {
  const l = await ownedLesson(req, param(req, "id"));
  await prisma.lesson.delete({ where: { id: l.id } });
  res.status(204).end();
});

// Lesson media (images for cover / prototype / steps)
lessonsRouter.post("/media", imageUpload("lessons"), async (req, res) => {
  const f = await verifyImageFile(req);
  res.status(201).json({ url: f.url });
});
