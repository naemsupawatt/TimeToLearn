import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound, param, parse, parseJson, reqText, text } from "../lib/http.js";
import { HELP_STATUSES } from "../lib/constants.js";
import { ownedClassroom, ownedLesson, ownedSession, requireUser } from "../middleware/auth.js";
import { deleteUpload } from "../middleware/upload.js";
import { emit, rooms } from "../realtime/socket.js";
import { activeSessionFor, buildGroupCard, displayName, ensureProgressRows, pushGroupUpdate } from "../services/live.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireUser("TEACHER", "ADMIN"));

/** Start a lesson in a classroom. Any previous active session is ended. */
sessionsRouter.post("/", async (req, res) => {
  const b = parse(z.object({ classroomId: z.string(), lessonId: z.string() }), req.body);
  const c = await ownedClassroom(req, b.classroomId);
  const l = await ownedLesson(req, b.lessonId);
  if (l.status !== "PUBLISHED") throw badRequest("Publish the lesson before starting it");
  const groups = await prisma.group.count({ where: { classroomId: c.id } });
  if (!groups) throw badRequest("Create groups in this classroom first");
  await prisma.classroomSession.updateMany({ where: { classroomId: c.id, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date() } });
  const session = await prisma.classroomSession.create({ data: { classroomId: c.id, lessonId: l.id } });
  await ensureProgressRows(session.id);
  emit(rooms.groups(c.id), "session:update", { sessionId: session.id, status: "ACTIVE" });
  res.status(201).json(session);
});

sessionsRouter.post("/:id/end", async (req, res) => {
  const s = await ownedSession(req, param(req, "id"));
  const updated = await prisma.classroomSession.update({ where: { id: s.id }, data: { status: "ENDED", endedAt: new Date() } });
  emit(rooms.groups(s.classroomId), "session:update", { sessionId: s.id, status: "ENDED" });
  res.json(updated);
});

/** Live Classroom snapshot: active session + one card per group. */
sessionsRouter.get("/live/:classroomId", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "classroomId"));
  const session = await activeSessionFor(c.id);
  if (!session) return res.json({ classroom: c, session: null, cards: [] });
  await ensureProgressRows(session.id);
  const groups = await prisma.group.findMany({ where: { classroomId: c.id }, orderBy: { name: "asc" } });
  const cards = await Promise.all(groups.map((g) => buildGroupCard(session.id, g.id)));
  const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: session.lessonId }, select: { id: true, title: true, unitName: true } });
  res.json({ classroom: c, session: { ...session, lesson }, cards });
});

/** Everything about one group in a session (for the detail drawer). */
sessionsRouter.get("/:id/groups/:groupId", async (req, res) => {
  const s = await ownedSession(req, param(req, "id"));
  const groupId = param(req, "groupId");
  const group = await prisma.group.findFirst({ where: { id: groupId, classroomId: s.classroomId } });
  if (!group) throw notFound("Group");
  const [card, progress, lesson, submissions, help, messages, events] = await Promise.all([
    buildGroupCard(s.id, groupId),
    prisma.groupProgress.findUnique({ where: { sessionId_groupId: { sessionId: s.id, groupId } } }),
    prisma.lesson.findUniqueOrThrow({ where: { id: s.lessonId }, include: { steps: { orderBy: { order: "asc" } } } }),
    prisma.submission.findMany({ where: { sessionId: s.id, groupId }, include: { analysis: true, mission: { select: { title: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.helpRequest.findMany({ where: { sessionId: s.id, groupId }, orderBy: { createdAt: "desc" } }),
    prisma.notification.findMany({ where: { groupId, type: "TEACHER_MESSAGE", createdAt: { gte: s.startedAt } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.learningAnalytics.findMany({ where: { sessionId: s.id, groupId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const answers = parseJson<Record<string, { checked?: boolean[]; answer?: string }>>(progress?.stepAnswers, {});
  res.json({
    card,
    steps: lesson.steps.map((st, i) => ({
      index: i, id: st.id, phase: st.phase, title: st.title,
      completed: parseJson<number[]>(progress?.completedSteps, []).includes(i),
      answer: answers[st.id]?.answer ?? null,
    })),
    submissions: submissions.map((x) => ({ ...x, analysis: x.analysis ? { ...x.analysis, result: parseJson(x.analysis.result, null) } : null })),
    help,
    messages,
    events: events.map((e) => ({ ...e, data: parseJson(e.data, {}) })),
  });
});

/** Teacher -> group iPad message. */
sessionsRouter.post("/:id/groups/:groupId/message", async (req, res) => {
  const s = await ownedSession(req, param(req, "id"));
  const groupId = param(req, "groupId");
  const group = await prisma.group.findFirst({ where: { id: groupId, classroomId: s.classroomId } });
  if (!group) throw notFound("Group");
  const { message } = parse(z.object({ message: reqText(1000) }), req.body);
  const n = await prisma.notification.create({
    data: { groupId, type: "TEACHER_MESSAGE", title: req.auth?.name ?? "Teacher", body: message },
  });
  emit(rooms.group(groupId), "teacher:message", n);
  res.status(201).json(n);
});

sessionsRouter.patch("/help/:helpId", async (req, res) => {
  const h = await prisma.helpRequest.findUnique({ where: { id: param(req, "helpId") } });
  if (!h) throw notFound("Help request");
  await ownedSession(req, h.sessionId);
  const b = parse(z.object({ status: z.enum(HELP_STATUSES), reply: text(1000).nullable().optional() }), req.body);
  const updated = await prisma.helpRequest.update({
    where: { id: h.id },
    data: { status: b.status, teacherReply: b.reply ?? h.teacherReply, resolvedAt: b.status === "RESOLVED" ? new Date() : null },
  });
  emit(rooms.group(h.groupId), "help:update", updated);
  await pushGroupUpdate(h.sessionId, h.groupId);
  res.json(updated);
});

sessionsRouter.patch("/submissions/:submissionId/review", async (req, res) => {
  const sub = await prisma.submission.findUnique({ where: { id: param(req, "submissionId") } });
  if (!sub) throw notFound("Submission");
  await ownedSession(req, sub.sessionId);
  const b = parse(z.object({ status: z.enum(["APPROVED", "NEEDS_WORK"]), feedback: text(2000).nullable().optional() }), req.body);
  const updated = await prisma.submission.update({
    where: { id: sub.id },
    data: { status: b.status, teacherFeedback: b.feedback ?? null, reviewedAt: new Date() },
  });
  emit(rooms.group(sub.groupId), "submission:reviewed", updated);
  await pushGroupUpdate(sub.sessionId, sub.groupId);
  res.json(updated);
});

/** Delete a submission and its photo (privacy). */
sessionsRouter.delete("/submissions/:submissionId", async (req, res) => {
  const sub = await prisma.submission.findUnique({ where: { id: param(req, "submissionId") } });
  if (!sub) throw notFound("Submission");
  await ownedSession(req, sub.sessionId);
  await prisma.submission.delete({ where: { id: sub.id } });
  await deleteUpload(sub.imageUrl);
  await pushGroupUpdate(sub.sessionId, sub.groupId);
  res.status(204).end();
});

/** Session list for a classroom (used by assessment and analytics filters). */
sessionsRouter.get("/by-classroom/:classroomId", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "classroomId"));
  const rows = await prisma.classroomSession.findMany({
    where: { classroomId: c.id },
    include: { lesson: { select: { id: true, title: true } } },
    orderBy: { startedAt: "desc" },
  });
  res.json(rows);
});
