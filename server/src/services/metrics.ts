import { prisma } from "../lib/prisma.js";
import { parseJson } from "../lib/http.js";
import { PHASES } from "../lib/constants.js";

/** Group-level learning metrics for one session (no personal data). */
export async function groupSessionMetrics(sessionId: string, groupId: string) {
  const [session, progress, submissions, help, events] = await Promise.all([
    prisma.classroomSession.findUniqueOrThrow({ where: { id: sessionId }, include: { lesson: { include: { steps: { orderBy: { order: "asc" } } } } } }),
    prisma.groupProgress.findUnique({ where: { sessionId_groupId: { sessionId, groupId } } }),
    prisma.submission.findMany({ where: { sessionId, groupId }, include: { analysis: true } }),
    prisma.helpRequest.findMany({ where: { sessionId, groupId }, select: { category: true } }),
    prisma.learningAnalytics.findMany({ where: { sessionId, groupId } }),
  ]);
  const completed = parseJson<number[]>(progress?.completedSteps, []);
  const answers = parseJson<Record<string, { answer?: string }>>(progress?.stepAnswers, {});
  const end = progress?.completedAt ?? session.endedAt ?? new Date();
  const minutesSpent = progress?.startedAt ? Math.round((end.getTime() - progress.startedAt.getTime()) / 60000) : 0;
  const aiFindings = submissions
    .flatMap((s) => parseJson<{ possibleIssues?: string[] }>(s.analysis?.result, {}).possibleIssues ?? [])
    .slice(0, 6);
  const reflectionAnswers = session.lesson.steps
    .filter((st) => st.phase === "REFLECTION")
    .map((st) => answers[st.id]?.answer)
    .filter((a): a is string => !!a)
    .map((a) => a.slice(0, 300));
  return {
    lessonTitle: session.lesson.title,
    stepsCompleted: completed.length,
    totalSteps: session.lesson.steps.length,
    minutesSpent,
    submissions: submissions.length,
    improvements: submissions.filter((s) => s.attempt > 1).length,
    helpRequests: help,
    aiFindings,
    reflectionAnswers,
    chats: events.filter((e) => e.type === "AI_CHAT").length,
  };
}

/** Classroom analytics for charts. */
export async function classroomAnalytics(classroomId: string, sessionId?: string) {
  const sessions = await prisma.classroomSession.findMany({
    where: { classroomId, ...(sessionId ? { id: sessionId } : {}) },
    include: { lesson: { select: { title: true } } },
    orderBy: { startedAt: "asc" },
  });
  const ids = sessions.map((s) => s.id);
  const [groups, progress, submissions, help, events, assessments, rubric] = await Promise.all([
    prisma.group.findMany({ where: { classroomId }, orderBy: { name: "asc" } }),
    prisma.groupProgress.findMany({ where: { sessionId: { in: ids } } }),
    prisma.submission.findMany({ where: { sessionId: { in: ids } }, select: { groupId: true, sessionId: true, attempt: true } }),
    prisma.helpRequest.findMany({ where: { sessionId: { in: ids } }, select: { groupId: true, category: true, createdAt: true, resolvedAt: true } }),
    prisma.learningAnalytics.findMany({ where: { sessionId: { in: ids }, type: "STEP_COMPLETED" }, select: { phase: true, durationSec: true } }),
    prisma.assessment.findMany({
      where: { sessionId: { in: ids }, status: "CONFIRMED" },
      include: { rubric: { include: { criteria: true } } },
    }),
    prisma.classroom.findUniqueOrThrow({ where: { id: classroomId } }).then((c) =>
      c.rubricId ? prisma.rubric.findUnique({ where: { id: c.rubricId }, include: { criteria: { orderBy: { order: "asc" } } } }) : null,
    ),
  ]);

  const started = progress.filter((p) => p.startedAt);
  const completed = progress.filter((p) => p.status === "COMPLETED");

  const perGroup = groups.map((g) => {
    const gp = progress.filter((p) => p.groupId === g.id && p.startedAt);
    const durations = gp
      .filter((p) => p.completedAt && p.startedAt)
      .map((p) => (p.completedAt!.getTime() - p.startedAt!.getTime()) / 60000);
    const subs = submissions.filter((s) => s.groupId === g.id);
    return {
      groupId: g.id,
      name: g.name,
      color: g.color,
      submissions: subs.length,
      improvements: subs.filter((s) => s.attempt > 1).length,
      helpRequests: help.filter((h) => h.groupId === g.id).length,
      missionsCompleted: gp.filter((p) => p.status === "COMPLETED").length,
      avgMissionMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    };
  });

  const perPhase = PHASES.map((phase) => {
    const d = events.filter((e) => e.phase === phase && e.durationSec != null).map((e) => e.durationSec!);
    return { phase, avgMinutes: d.length ? Math.round((d.reduce((a, b) => a + b, 0) / d.length / 60) * 10) / 10 : 0, count: d.length };
  });

  const timeline = sessions.map((s) => {
    const sp = progress.filter((p) => p.sessionId === s.id);
    const sa = assessments.filter((a) => a.sessionId === s.id);
    return {
      sessionId: s.id,
      label: `${s.startedAt.toISOString().slice(0, 10)} ${s.lesson.title}`,
      date: s.startedAt,
      lesson: s.lesson.title,
      completionRate: sp.length ? Math.round((sp.filter((p) => p.status === "COMPLETED").length / sp.length) * 100) : 0,
      avgAssessment: sa.length ? Math.round(sa.reduce((x, a) => x + a.totalPercent, 0) / sa.length) : null,
      submissions: submissions.filter((x) => x.sessionId === s.id).length,
    };
  });

  // Skill radar: average % per criterion name across confirmed assessments.
  const skillMap = new Map<string, { sum: number; n: number }>();
  for (const a of assessments) {
    const scores = parseJson<Record<string, number>>(a.scores, {});
    for (const c of a.rubric.criteria) {
      const v = scores[c.id];
      if (typeof v !== "number") continue;
      const cur = skillMap.get(c.name) ?? { sum: 0, n: 0 };
      cur.sum += (v / c.maxScore) * 100;
      cur.n++;
      skillMap.set(c.name, cur);
    }
  }
  const skillNames = rubric?.criteria.map((c) => c.name) ?? [...skillMap.keys()];
  const skills = skillNames.map((name) => {
    const s = skillMap.get(name);
    return { skill: name, percent: s ? Math.round(s.sum / s.n) : null };
  });
  const toImprove = skills
    .filter((s): s is { skill: string; percent: number } => s.percent !== null)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 2);

  const helpWaits = help.filter((h) => h.resolvedAt).map((h) => (h.resolvedAt!.getTime() - h.createdAt.getTime()) / 60000);

  return {
    summary: {
      sessions: sessions.length,
      missionCompletionRate: started.length ? Math.round((completed.length / started.length) * 100) : null,
      submissions: submissions.length,
      improvements: submissions.filter((s) => s.attempt > 1).length,
      helpRequests: help.length,
      avgHelpWaitMinutes: helpWaits.length ? Math.round((helpWaits.reduce((a, b) => a + b, 0) / helpWaits.length) * 10) / 10 : null,
      confirmedAssessments: assessments.length,
    },
    perGroup,
    perPhase,
    timeline,
    skills,
    toImprove,
    helpByCategory: ["BUILD", "CODING", "EQUIPMENT", "MISSION", "OTHER"].map((c) => ({ category: c, count: help.filter((h) => h.category === c).length })),
  };
}
