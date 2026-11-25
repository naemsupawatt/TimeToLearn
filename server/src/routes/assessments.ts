import { Router } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, notFound, param, parse, parseJson, text } from "../lib/http.js";
import { ownedClassroom, ownedSession, requireUser, userOf } from "../middleware/auth.js";
import { assessmentObservations, checkDailyLimit, type Lang } from "../services/ai.js";
import { classroomAnalytics, groupSessionMetrics } from "../services/metrics.js";
import { displayName } from "../services/live.js";

export const assessmentsRouter = Router();
assessmentsRouter.use(requireUser("TEACHER", "ADMIN"));

type Criterion = { id: string; name: string; maxScore: number; weight: number };

export function weightedPercent(criteria: Criterion[], scores: Record<string, number>) {
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  if (!totalWeight) return 0;
  const sum = criteria.reduce((s, c) => s + (Math.min(scores[c.id] ?? 0, c.maxScore) / c.maxScore) * c.weight, 0);
  return Math.round((sum / totalWeight) * 1000) / 10;
}

async function rubricFor(sessionId: string) {
  const s = await prisma.classroomSession.findUniqueOrThrow({ where: { id: sessionId }, include: { lesson: true, classroom: true } });
  const rubricId = s.lesson.rubricId ?? s.classroom.rubricId;
  const rubric = rubricId
    ? await prisma.rubric.findUnique({ where: { id: rubricId }, include: { criteria: { orderBy: { order: "asc" } } } })
    : await prisma.rubric.findFirst({ where: { teacherId: s.classroom.teacherId }, orderBy: { isDefault: "desc" }, include: { criteria: { orderBy: { order: "asc" } } } });
  if (!rubric) throw badRequest("No rubric found. Create a rubric first.");
  return rubric;
}

/** Assessment sheet for one session: rubric + students grouped + existing scores. */
assessmentsRouter.get("/session/:sessionId", async (req, res) => {
  const s = await ownedSession(req, param(req, "sessionId"));
  const rubric = await rubricFor(s.id);
  const [groups, assessments, ungrouped] = await Promise.all([
    prisma.group.findMany({ where: { classroomId: s.classroomId }, orderBy: { name: "asc" }, include: { members: { include: { student: true } } } }),
    prisma.assessment.findMany({ where: { sessionId: s.id } }),
    prisma.student.findMany({ where: { classroomId: s.classroomId, membership: null }, orderBy: { studentNo: "asc" } }),
  ]);
  const toStudent = (st: { id: string; studentNo: string; firstName: string; lastName: string; nickname: string | null }) => {
    const a = assessments.find((x) => x.studentId === st.id);
    return {
      id: st.id, studentNo: st.studentNo, name: displayName(st),
      assessment: a ? { ...a, scores: parseJson<Record<string, number>>(a.scores, {}) } : null,
    };
  };
  res.json({
    session: s,
    rubric,
    groups: [
      ...groups.map((g) => ({
        id: g.id, name: g.name, color: g.color,
        students: g.members.map((m) => m.student).sort((a, b) => a.studentNo.localeCompare(b.studentNo, undefined, { numeric: true })).map(toStudent),
      })),
      ...(ungrouped.length ? [{ id: "ungrouped", name: "No group", color: "gray", students: ungrouped.map(toStudent) }] : []),
    ],
  });
});

/** Save scores for many students at once (draft or confirm). The teacher's numbers are final. */
assessmentsRouter.put("/session/:sessionId", async (req, res) => {
  const s = await ownedSession(req, param(req, "sessionId"));
  const u = userOf(req);
  const rubric = await rubricFor(s.id);
  const b = parse(
    z.object({
      items: z
        .array(
          z.object({
            studentId: z.string(),
            scores: z.record(z.string(), z.number().min(0)),
            comment: text(2000).nullable().optional(),
            aiObservation: text(4000).nullable().optional(),
            status: z.enum(["DRAFT", "CONFIRMED"]),
          }),
        )
        .min(1)
        .max(200),
    }),
    req.body,
  );
  const students = await prisma.student.findMany({ where: { classroomId: s.classroomId }, select: { id: true } });
  const allowed = new Set(students.map((x) => x.id));
  const saved = [];
  for (const it of b.items) {
    if (!allowed.has(it.studentId)) throw badRequest("Student is not in this classroom");
    const scores: Record<string, number> = {};
    for (const c of rubric.criteria) {
      const v = it.scores[c.id];
      if (v === undefined) continue;
      if (v > c.maxScore) throw badRequest(`Score for ${c.name} exceeds max ${c.maxScore}`);
      scores[c.id] = v;
    }
    if (it.status === "CONFIRMED" && Object.keys(scores).length < rubric.criteria.length) {
      throw badRequest("Fill every criterion before confirming");
    }
    const data = {
      rubricId: rubric.id, scores: JSON.stringify(scores), totalPercent: weightedPercent(rubric.criteria, scores),
      comment: it.comment ?? null, aiObservation: it.aiObservation ?? undefined, status: it.status, assessedById: u.id,
      confirmedAt: it.status === "CONFIRMED" ? new Date() : null,
    };
    saved.push(
      await prisma.assessment.upsert({
        where: { studentId_sessionId: { studentId: it.studentId, sessionId: s.id } },
        create: { ...data, studentId: it.studentId, sessionId: s.id },
        update: data,
      }),
    );
  }
  res.json({ saved: saved.length });
});

/** AI observations for a group (teacher-facing, never a score). */
assessmentsRouter.post("/session/:sessionId/ai-observations", async (req, res) => {
  const s = await ownedSession(req, param(req, "sessionId"));
  const { groupId, lang } = parse(z.object({ groupId: z.string(), lang: z.enum(["th", "en"]).default("th") }), req.body);
  const g = await prisma.group.findFirst({ where: { id: groupId, classroomId: s.classroomId } });
  if (!g) throw notFound("Group");
  await checkDailyLimit(g.id);
  const rubric = await rubricFor(s.id);
  const metrics = await groupSessionMetrics(s.id, g.id);
  const { mode, text: observation } = await assessmentObservations({ ...metrics, criteria: rubric.criteria.map((c) => c.name) }, lang as Lang);
  res.json({ observation, demo: mode.demo, metrics });
});

/** Excel export of a session's assessments. */
assessmentsRouter.get("/session/:sessionId/export.xlsx", async (req, res) => {
  const s = await ownedSession(req, param(req, "sessionId"));
  const rubric = await rubricFor(s.id);
  const full = await prisma.classroomSession.findUniqueOrThrow({ where: { id: s.id }, include: { classroom: true, lesson: true } });
  const students = await prisma.student.findMany({
    where: { classroomId: s.classroomId },
    include: { membership: { include: { group: true } }, assessments: { where: { sessionId: s.id } } },
    orderBy: { studentNo: "asc" },
  });
  const wb = new ExcelJS.Workbook();
  wb.creator = "RoboLearn AI";
  const ws = wb.addWorksheet("Assessment");
  ws.addRow([`${full.classroom.name} - ${full.lesson.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`Session: ${full.startedAt.toISOString().slice(0, 10)}   Rubric: ${rubric.name}`]);
  ws.addRow([]);
  const header = ["No.", "Name", "Group", ...rubric.criteria.map((c) => `${c.name} (/${c.maxScore}, w${c.weight})`), "Total %", "Status", "Comment"];
  const hr = ws.addRow(header);
  hr.font = { bold: true };
  hr.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E7FF" } }));
  for (const st of students) {
    const a = st.assessments[0];
    const scores = parseJson<Record<string, number>>(a?.scores, {});
    ws.addRow([
      st.studentNo, `${st.firstName} ${st.lastName}`.trim(), st.membership?.group.name ?? "-",
      ...rubric.criteria.map((c) => scores[c.id] ?? ""), a ? a.totalPercent : "", a?.status ?? "NOT ASSESSED", a?.comment ?? "",
    ]);
  }
  ws.columns.forEach((col, i) => (col.width = i === 1 ? 26 : i === header.length - 1 ? 40 : 14));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="assessment-${s.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---- Analytics ----
assessmentsRouter.get("/analytics/:classroomId", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "classroomId"));
  const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId ? req.query.sessionId : undefined;
  res.json(await classroomAnalytics(c.id, sessionId));
});

/** Per-student development across sessions (line + radar). */
assessmentsRouter.get("/student/:studentId", async (req, res) => {
  const st = await prisma.student.findUnique({ where: { id: param(req, "studentId") } });
  if (!st) throw notFound("Student");
  await ownedClassroom(req, st.classroomId);
  const rows = await prisma.assessment.findMany({
    where: { studentId: st.id, status: "CONFIRMED" },
    include: { session: { include: { lesson: { select: { title: true } } } }, rubric: { include: { criteria: true } } },
    orderBy: { session: { startedAt: "asc" } },
  });
  res.json({
    student: { id: st.id, name: displayName(st), studentNo: st.studentNo },
    timeline: rows.map((a) => ({ date: a.session.startedAt, lesson: a.session.lesson.title, percent: a.totalPercent })),
    latest: rows.length
      ? rows[rows.length - 1].rubric.criteria.map((c) => ({
          skill: c.name,
          percent: Math.round(((parseJson<Record<string, number>>(rows[rows.length - 1].scores, {})[c.id] ?? 0) / c.maxScore) * 100),
        }))
      : [],
  });
});
