import { Router } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, param, parse, reqText, text } from "../lib/http.js";
import { GROUP_COLORS } from "../lib/constants.js";
import { ownedClassroom, ownedGroup, requireUser, userOf } from "../middleware/auth.js";
import { xlsxUpload, deleteUpload } from "../middleware/upload.js";
import { generatePin } from "../services/pin.js";
import { displayName } from "../services/live.js";

export const classroomsRouter = Router();
classroomsRouter.use(requireUser("TEACHER", "ADMIN"));

const classroomBody = z.object({
  name: reqText(120),
  gradeLevel: reqText(40),
  description: text(1000).nullable().optional(),
  rubricId: z.string().nullable().optional(),
});

const studentBody = z.object({
  studentNo: reqText(20),
  firstName: reqText(80),
  lastName: text(80).default(""),
  nickname: text(40).nullable().optional(),
});

const groupBody = z.object({
  name: reqText(60),
  color: z.enum(GROUP_COLORS).default("blue"),
});

// ---------------------------------------------------------------------------
// Classrooms
// ---------------------------------------------------------------------------

classroomsRouter.get("/", async (req, res) => {
  const u = userOf(req);
  const rows = await prisma.classroom.findMany({
    where: u.role === "ADMIN" ? {} : { teacherId: u.id },
    include: {
      _count: { select: { students: true, groups: true } },
      sessions: { where: { status: "ACTIVE" }, select: { id: true, lesson: { select: { title: true } } }, take: 1 },
      teacher: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(rows.map(({ sessions, ...c }) => ({ ...c, activeSession: sessions[0] ?? null })));
});

classroomsRouter.post("/", async (req, res) => {
  const u = userOf(req);
  const b = parse(classroomBody, req.body);
  const me = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
  const defaultRubric = await prisma.rubric.findFirst({ where: { teacherId: u.id }, orderBy: { isDefault: "desc" } });
  const c = await prisma.classroom.create({
    data: { ...b, rubricId: b.rubricId ?? defaultRubric?.id ?? null, teacherId: u.id, schoolId: me.schoolId },
  });
  res.status(201).json(c);
});

classroomsRouter.get("/:id", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const full = await prisma.classroom.findUniqueOrThrow({
    where: { id: c.id },
    include: {
      students: { orderBy: { studentNo: "asc" }, include: { membership: { select: { groupId: true, role: true } } } },
      groups: { orderBy: { name: "asc" }, include: { members: { include: { student: true } } } },
      rubric: { include: { criteria: { orderBy: { order: "asc" } } } },
      sessions: { orderBy: { startedAt: "desc" }, include: { lesson: { select: { id: true, title: true } } } },
    },
  });
  res.json({
    ...full,
    groups: full.groups.map((g) => ({
      ...g,
      members: g.members.map((m) => ({ id: m.studentId, name: displayName(m.student), role: m.role })),
    })),
  });
});

classroomsRouter.patch("/:id", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  res.json(await prisma.classroom.update({ where: { id: c.id }, data: parse(classroomBody.partial(), req.body) }));
});

classroomsRouter.delete("/:id", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  // Delete uploaded photos too (privacy).
  const subs = await prisma.submission.findMany({ where: { session: { classroomId: c.id } }, select: { imageUrl: true } });
  await prisma.classroom.delete({ where: { id: c.id } });
  await Promise.all(subs.map((s) => deleteUpload(s.imageUrl)));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

classroomsRouter.post("/:id/students", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const b = parse(studentBody, req.body);
  res.status(201).json(await prisma.student.create({ data: { ...b, classroomId: c.id } }));
});

classroomsRouter.patch("/:id/students/:studentId", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const s = await prisma.student.findFirst({ where: { id: param(req, "studentId"), classroomId: c.id } });
  if (!s) throw badRequest("Student is not in this classroom");
  res.json(await prisma.student.update({ where: { id: s.id }, data: parse(studentBody.partial(), req.body) }));
});

classroomsRouter.delete("/:id/students/:studentId", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const r = await prisma.student.deleteMany({ where: { id: param(req, "studentId"), classroomId: c.id } });
  if (!r.count) throw badRequest("Student is not in this classroom");
  res.status(204).end();
});

classroomsRouter.get("/:id/students/template.xlsx", async (req, res) => {
  await ownedClassroom(req, param(req, "id"));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students");
  ws.columns = [
    { header: "studentNo", key: "studentNo", width: 12 },
    { header: "firstName", key: "firstName", width: 20 },
    { header: "lastName", key: "lastName", width: 20 },
    { header: "nickname", key: "nickname", width: 14 },
    { header: "group", key: "group", width: 14 },
  ];
  ws.addRow({ studentNo: "1", firstName: "ตัวอย่าง", lastName: "นักเรียน", nickname: "ต้น", group: "Group 1" });
  ws.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="students-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

/** Import students from .xlsx. Columns: studentNo, firstName, lastName, nickname, group (optional). */
classroomsRouter.post("/:id/students/import", xlsxUpload, async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  if (!req.file) throw badRequest("No file uploaded (field name: file)");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
  } catch {
    throw badRequest("Could not read the Excel file");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest("The workbook has no sheets");

  const header: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    header[String(cell.text).trim().toLowerCase().replace(/[\s_]/g, "")] = col;
  });
  const col = (...names: string[]) => names.map((n) => header[n]).find(Boolean);
  const cNo = col("studentno", "no", "เลขที่", "รหัส"), cFirst = col("firstname", "ชื่อ"), cLast = col("lastname", "นามสกุล");
  const cNick = col("nickname", "ชื่อเล่น"), cGroup = col("group", "กลุ่ม");
  if (!cNo || !cFirst) throw badRequest("Missing required columns: studentNo, firstName");

  const rows: { studentNo: string; firstName: string; lastName: string; nickname: string | null; group: string | null; row: number }[] = [];
  const errors: { row: number; message: string }[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (ci?: number) => (ci ? String(row.getCell(ci).text ?? "").trim() : "");
    const r = { studentNo: get(cNo), firstName: get(cFirst), lastName: get(cLast), nickname: get(cNick) || null, group: get(cGroup) || null, row: n };
    if (!r.studentNo && !r.firstName) return; // blank row
    if (!r.studentNo || !r.firstName) errors.push({ row: n, message: "studentNo and firstName are required" });
    else if (r.studentNo.length > 20 || r.firstName.length > 80 || r.lastName.length > 80) errors.push({ row: n, message: "Value too long" });
    else rows.push(r);
  });
  if (rows.length > 500) throw badRequest("Too many rows (max 500)");

  let created = 0, updated = 0, grouped = 0;
  const groups = await prisma.group.findMany({ where: { classroomId: c.id } });
  for (const r of rows) {
    const existing = await prisma.student.findUnique({ where: { classroomId_studentNo: { classroomId: c.id, studentNo: r.studentNo } } });
    const data = { firstName: r.firstName, lastName: r.lastName, nickname: r.nickname };
    const s = existing
      ? await prisma.student.update({ where: { id: existing.id }, data })
      : await prisma.student.create({ data: { ...data, studentNo: r.studentNo, classroomId: c.id } });
    if (existing) updated++;
    else created++;
    if (r.group) {
      let g = groups.find((x) => x.name.toLowerCase() === r.group!.toLowerCase());
      if (!g) {
        g = await prisma.group.create({
          data: { classroomId: c.id, name: r.group.slice(0, 60), pin: await generatePin(), color: GROUP_COLORS[groups.length % GROUP_COLORS.length] },
        });
        groups.push(g);
      }
      await prisma.groupMember.upsert({ where: { studentId: s.id }, create: { studentId: s.id, groupId: g.id }, update: { groupId: g.id } });
      grouped++;
    }
  }
  res.json({ created, updated, grouped, errors });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

classroomsRouter.post("/:id/groups", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const b = parse(groupBody, req.body);
  res.status(201).json(await prisma.group.create({ data: { ...b, classroomId: c.id, pin: await generatePin() } }));
});

/** Create N groups (if needed) and distribute ungrouped (or all) students round-robin. */
classroomsRouter.post("/:id/groups/auto", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const b = parse(z.object({ count: z.number().int().min(1).max(12), reshuffle: z.boolean().default(false) }), req.body);
  let groups = await prisma.group.findMany({ where: { classroomId: c.id }, orderBy: { name: "asc" } });
  for (let i = groups.length; i < b.count; i++) {
    groups.push(
      await prisma.group.create({
        data: { classroomId: c.id, name: `Group ${i + 1}`, pin: await generatePin(), color: GROUP_COLORS[i % GROUP_COLORS.length] },
      }),
    );
  }
  groups = groups.slice(0, b.count);
  if (b.reshuffle) await prisma.groupMember.deleteMany({ where: { group: { classroomId: c.id } } });
  const students = await prisma.student.findMany({
    where: { classroomId: c.id, ...(b.reshuffle ? {} : { membership: null }) },
    orderBy: { studentNo: "asc" },
  });
  const shuffled = b.reshuffle ? students.sort(() => Math.random() - 0.5) : students;
  const counts = await Promise.all(groups.map((g) => prisma.groupMember.count({ where: { groupId: g.id } })));
  for (const s of shuffled) {
    const i = counts.indexOf(Math.min(...counts));
    await prisma.groupMember.create({ data: { studentId: s.id, groupId: groups[i].id } });
    counts[i]++;
  }
  res.json({ groups: groups.length, assigned: shuffled.length });
});

classroomsRouter.patch("/groups/:groupId", async (req, res) => {
  const g = await ownedGroup(req, param(req, "groupId"));
  res.json(await prisma.group.update({ where: { id: g.id }, data: parse(groupBody.partial(), req.body) }));
});

classroomsRouter.post("/groups/:groupId/regenerate-pin", async (req, res) => {
  const g = await ownedGroup(req, param(req, "groupId"));
  res.json(await prisma.group.update({ where: { id: g.id }, data: { pin: await generatePin() } }));
});

classroomsRouter.delete("/groups/:groupId", async (req, res) => {
  const g = await ownedGroup(req, param(req, "groupId"));
  await prisma.group.delete({ where: { id: g.id } });
  res.status(204).end();
});

/** Assign one student to a group (or remove from any group with groupId = null). */
classroomsRouter.put("/:id/students/:studentId/group", async (req, res) => {
  const c = await ownedClassroom(req, param(req, "id"));
  const b = parse(z.object({ groupId: z.string().nullable(), role: text(40).nullable().optional() }), req.body);
  const s = await prisma.student.findFirst({ where: { id: param(req, "studentId"), classroomId: c.id } });
  if (!s) throw badRequest("Student is not in this classroom");
  if (b.groupId === null) {
    await prisma.groupMember.deleteMany({ where: { studentId: s.id } });
    return res.json({ ok: true });
  }
  const g = await prisma.group.findFirst({ where: { id: b.groupId, classroomId: c.id } });
  if (!g) throw badRequest("Group is not in this classroom");
  await prisma.groupMember.upsert({
    where: { studentId: s.id },
    create: { studentId: s.id, groupId: g.id, role: b.role ?? null },
    update: { groupId: g.id, role: b.role ?? undefined },
  });
  res.json({ ok: true });
});
