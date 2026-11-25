import { prisma } from "../lib/prisma.js";
import { parseJson } from "../lib/http.js";
import type { GroupStatus } from "../lib/constants.js";
import { emit, rooms } from "../realtime/socket.js";

export function displayName(s: { firstName: string; lastName: string; nickname: string | null }) {
  return s.nickname ? `${s.firstName} (${s.nickname})` : `${s.firstName} ${s.lastName}`;
}

/** Make sure a GroupProgress row exists for each group of the session's classroom. */
export async function ensureProgressRows(sessionId: string) {
  const session = await prisma.classroomSession.findUniqueOrThrow({ where: { id: sessionId } });
  const groups = await prisma.group.findMany({ where: { classroomId: session.classroomId }, select: { id: true } });
  for (const g of groups) {
    await prisma.groupProgress.upsert({
      where: { sessionId_groupId: { sessionId, groupId: g.id } },
      create: { sessionId, groupId: g.id },
      update: {},
    });
  }
}

/**
 * Status priority: an open help request always wins (red), then completion
 * (green), then work waiting for the teacher (yellow), then learning (blue).
 */
export async function recomputeStatus(sessionId: string, groupId: string): Promise<GroupStatus> {
  const progress = await prisma.groupProgress.findUnique({ where: { sessionId_groupId: { sessionId, groupId } } });
  if (!progress) return "NOT_STARTED";
  const session = await prisma.classroomSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: { lesson: { include: { _count: { select: { steps: true } } } } },
  });
  const openHelp = await prisma.helpRequest.count({ where: { sessionId, groupId, status: { not: "RESOLVED" } } });
  const pending = await prisma.submission.count({ where: { sessionId, groupId, status: "SUBMITTED" } });
  const completed = parseJson<number[]>(progress.completedSteps, []);
  const totalSteps = session.lesson._count.steps;
  const allDone = totalSteps > 0 && completed.length >= totalSteps;

  let status: GroupStatus = "NOT_STARTED";
  if (openHelp > 0) status = "NEED_HELP";
  else if (allDone) status = "COMPLETED";
  else if (pending > 0) status = "WAITING_REVIEW";
  else if (progress.startedAt) status = "LEARNING";

  await prisma.groupProgress.update({
    where: { id: progress.id },
    data: {
      status,
      completedAt: allDone ? (progress.completedAt ?? new Date()) : null,
    },
  });
  return status;
}

export async function buildGroupCard(sessionId: string, groupId: string) {
  const [group, progress, session, latestSubmission, openHelp] = await Promise.all([
    prisma.group.findUniqueOrThrow({
      where: { id: groupId },
      include: { members: { include: { student: true } } },
    }),
    prisma.groupProgress.findUnique({ where: { sessionId_groupId: { sessionId, groupId } } }),
    prisma.classroomSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        lesson: {
          select: {
            title: true,
            steps: { orderBy: { order: "asc" }, select: { id: true, phase: true, title: true } },
            missions: { orderBy: { order: "asc" }, select: { title: true }, take: 1 },
          },
        },
      },
    }),
    prisma.submission.findFirst({ where: { sessionId, groupId }, orderBy: { createdAt: "desc" } }),
    prisma.helpRequest.findFirst({
      where: { sessionId, groupId, status: { not: "RESOLVED" } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const steps = session.lesson.steps;
  const completed = parseJson<number[]>(progress?.completedSteps, []);
  const idx = Math.min(progress?.currentStepIndex ?? 0, Math.max(steps.length - 1, 0));
  const end = progress?.completedAt ?? (session.endedAt ?? new Date());
  return {
    groupId: group.id,
    name: group.name,
    color: group.color,
    members: group.members.map((m) => ({ id: m.studentId, name: displayName(m.student), role: m.role })),
    lessonTitle: session.lesson.title,
    missionTitle: session.lesson.missions[0]?.title ?? null,
    currentStep: steps[idx] ? { index: idx, phase: steps[idx].phase, title: steps[idx].title } : null,
    totalSteps: steps.length,
    completedSteps: completed.length,
    progressPercent: steps.length ? Math.round((completed.length / steps.length) * 100) : 0,
    status: (progress?.status ?? "NOT_STARTED") as GroupStatus,
    startedAt: progress?.startedAt ?? null,
    elapsedSec: progress?.startedAt ? Math.max(0, Math.round((end.getTime() - progress.startedAt.getTime()) / 1000)) : 0,
    latestImageUrl: latestSubmission?.imageUrl ?? null,
    latestSubmissionStatus: latestSubmission?.status ?? null,
    help: openHelp
      ? { id: openHelp.id, category: openHelp.category, message: openHelp.message, status: openHelp.status, createdAt: openHelp.createdAt }
      : null,
    lastActivityAt: progress?.lastActivityAt ?? null,
  };
}

export type GroupCard = Awaited<ReturnType<typeof buildGroupCard>>;

/** Recompute status and push the fresh card to teachers watching the classroom. */
export async function pushGroupUpdate(sessionId: string, groupId: string) {
  await recomputeStatus(sessionId, groupId);
  const card = await buildGroupCard(sessionId, groupId);
  const session = await prisma.classroomSession.findUnique({ where: { id: sessionId } });
  if (session) emit(rooms.teachers(session.classroomId), "live:group", { sessionId, card });
  return card;
}

export async function activeSessionFor(classroomId: string) {
  return prisma.classroomSession.findFirst({
    where: { classroomId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
}

export async function logEvent(input: {
  sessionId: string;
  groupId: string;
  type: string;
  stepIndex?: number;
  phase?: string;
  durationSec?: number;
  data?: Record<string, unknown>;
}) {
  await prisma.learningAnalytics.create({
    data: { ...input, data: JSON.stringify(input.data ?? {}) },
  });
}

/** Notify the classroom's teacher (stored + realtime). */
export async function notifyTeacher(classroomId: string, n: { type: string; title: string; body: string; link?: string }) {
  const c = await prisma.classroom.findUnique({ where: { id: classroomId } });
  if (!c) return;
  const notification = await prisma.notification.create({ data: { ...n, userId: c.teacherId } });
  emit(rooms.user(c.teacherId), "notification", notification);
}
