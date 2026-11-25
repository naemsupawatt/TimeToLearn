import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireUser, userOf } from "../middleware/auth.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireUser("TEACHER", "ADMIN"));

dashboardRouter.get("/overview", async (req, res) => {
  const u = userOf(req);
  const classroomWhere = u.role === "ADMIN" ? {} : { teacherId: u.id };
  const classrooms = await prisma.classroom.findMany({ where: classroomWhere, select: { id: true, name: true } });
  const ids = classrooms.map((c) => c.id);
  const active = await prisma.classroomSession.findMany({
    where: { classroomId: { in: ids }, status: "ACTIVE" },
    include: { classroom: { select: { name: true } }, lesson: { select: { title: true } } },
  });
  const activeIds = active.map((s) => s.id);

  const [students, learningGroups, completedMissions, needHelp, recentSessions, liveProgress] = await Promise.all([
    prisma.student.count({ where: { classroomId: { in: ids } } }),
    prisma.groupProgress.count({ where: { sessionId: { in: activeIds }, status: { in: ["LEARNING", "WAITING_REVIEW", "NEED_HELP"] } } }),
    prisma.groupProgress.count({ where: { status: "COMPLETED", session: { classroomId: { in: ids } } } }),
    prisma.helpRequest.count({ where: { sessionId: { in: activeIds }, status: { not: "RESOLVED" } } }),
    prisma.classroomSession.findMany({
      where: { classroomId: { in: ids } },
      include: { lesson: { select: { title: true } }, classroom: { select: { name: true } }, progress: { select: { status: true, startedAt: true } } },
      orderBy: { startedAt: "desc" },
      take: 8,
    }),
    prisma.groupProgress.findMany({
      where: { sessionId: { in: activeIds } },
      include: { group: { select: { name: true, color: true } }, session: { include: { lesson: { include: { _count: { select: { steps: true } } } } } } },
    }),
  ]);

  res.json({
    stats: { classrooms: classrooms.length, students, learningGroups, completedMissions, needHelp },
    activeSessions: active.map((s) => ({ id: s.id, classroomId: s.classroomId, classroom: s.classroom.name, lesson: s.lesson.title, startedAt: s.startedAt })),
    // Progress of each group in live sessions (bar chart)
    liveProgress: liveProgress.map((p) => {
      const done = (JSON.parse(p.completedSteps) as number[]).length;
      const total = p.session.lesson._count.steps || 1;
      return { group: p.group.name, color: p.group.color, percent: Math.round((done / total) * 100), status: p.status };
    }),
    // Mission completion trend per session (line chart)
    trend: recentSessions
      .reverse()
      .map((s) => {
        const started = s.progress.filter((p) => p.startedAt).length || s.progress.length;
        const completed = s.progress.filter((p) => p.status === "COMPLETED").length;
        return {
          label: s.startedAt.toISOString().slice(5, 10),
          lesson: s.lesson.title,
          classroom: s.classroom.name,
          completionRate: started ? Math.round((completed / started) * 100) : 0,
        };
      }),
  });
});
