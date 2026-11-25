import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getSetting } from "../services/settings.js";

export const showcaseRouter = Router();

/** Real before/after results. Empty until the school records real data. */
export const evaluationSchema = z.object({
  items: z
    .array(
      z.object({
        metric: z.string().trim().min(1).max(200),
        before: z.number(),
        after: z.number(),
        unit: z.string().trim().max(30).default(""),
        sampleSize: z.number().int().min(1),
        method: z.string().trim().max(500).default(""),
        collectedOn: z.string().trim().max(40).default(""),
      }),
    )
    .max(30),
  note: z.string().trim().max(1000).default(""),
});

async function usage(isDemo: boolean) {
  const classroom = { isDemo };
  const [classrooms, students, groups, sessions, submissions, analyses, helpRequests, completed, progressRows, confirmed] =
    await Promise.all([
      prisma.classroom.count({ where: classroom }),
      prisma.student.count({ where: { classroom } }),
      prisma.group.count({ where: { classroom } }),
      prisma.classroomSession.count({ where: { classroom } }),
      prisma.submission.count({ where: { session: { classroom } } }),
      prisma.aIAnalysis.count({ where: { submission: { session: { classroom } } } }),
      prisma.helpRequest.count({ where: { session: { classroom } } }),
      prisma.groupProgress.count({ where: { status: "COMPLETED", session: { classroom } } }),
      prisma.groupProgress.count({ where: { startedAt: { not: null }, session: { classroom } } }),
      prisma.assessment.findMany({ where: { status: "CONFIRMED", session: { classroom } }, select: { totalPercent: true } }),
    ]);
  return {
    classrooms, students, groups, sessions, submissions, analyses, helpRequests,
    missionCompletionRate: progressRows ? Math.round((completed / progressRows) * 100) : null,
    confirmedAssessments: confirmed.length,
    avgAssessmentPercent: confirmed.length
      ? Math.round(confirmed.reduce((s, a) => s + a.totalPercent, 0) / confirmed.length)
      : null,
  };
}

// Public, aggregated only (no names). Real and demo data are reported separately.
showcaseRouter.get("/", async (_req, res) => {
  const [real, demo, evaluation] = await Promise.all([
    usage(false),
    usage(true),
    getSetting("showcase.evaluation", { items: [], note: "" } as z.infer<typeof evaluationSchema>),
  ]);
  res.json({ real, demo, evaluation });
});
