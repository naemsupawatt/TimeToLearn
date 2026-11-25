import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, param, parse, reqText, text } from "../lib/http.js";
import { requireUser, userOf } from "../middleware/auth.js";
import { aiSettingsSchema, getAiSettings, keyConfigured, setSetting } from "../services/settings.js";
import { env } from "../env.js";
import { evaluationSchema } from "./showcase.js";

export const adminRouter = Router();
adminRouter.use(requireUser("ADMIN"));

const publicUser = {
  id: true, email: true, name: true, role: true, active: true, schoolId: true, createdAt: true,
  school: { select: { id: true, name: true } },
  _count: { select: { classrooms: true, lessons: true } },
} as const;

// ---- Stats ----
adminRouter.get("/stats", async (_req, res) => {
  const [teachers, admins, schools, classrooms, students, sessions, analyses] = await Promise.all([
    prisma.user.count({ where: { role: "TEACHER" } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.school.count(),
    prisma.classroom.count(),
    prisma.student.count(),
    prisma.classroomSession.count(),
    prisma.aIAnalysis.count(),
  ]);
  res.json({ teachers, admins, schools, classrooms, students, sessions, analyses });
});

// ---- Users (teachers / admins) ----
const userCreate = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: reqText(120),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(["ADMIN", "TEACHER"]).default("TEACHER"),
  schoolId: z.string().nullable().optional(),
});

adminRouter.get("/users", async (_req, res) => {
  res.json(await prisma.user.findMany({ select: publicUser, orderBy: [{ role: "asc" }, { name: "asc" }] }));
});

adminRouter.post("/users", async (req, res) => {
  const b = parse(userCreate, req.body);
  const user = await prisma.user.create({
    data: { email: b.email, name: b.name, role: b.role, schoolId: b.schoolId || null, passwordHash: await bcrypt.hash(b.password, 12) },
    select: publicUser,
  });
  res.status(201).json(user);
});

adminRouter.patch("/users/:id", async (req, res) => {
  const id = param(req, "id");
  const me = userOf(req);
  const b = parse(
    userCreate.partial().extend({ active: z.boolean().optional(), password: z.string().min(8).max(200).optional() }),
    req.body,
  );
  if (id === me.id && (b.active === false || (b.role && b.role !== "ADMIN"))) {
    throw badRequest("You cannot disable or demote your own account");
  }
  const user = await prisma.user.update({
    where: { id },
    data: {
      email: b.email, name: b.name, role: b.role, active: b.active,
      schoolId: b.schoolId === undefined ? undefined : b.schoolId || null,
      passwordHash: b.password ? await bcrypt.hash(b.password, 12) : undefined,
    },
    select: publicUser,
  });
  res.json(user);
});

adminRouter.delete("/users/:id", async (req, res) => {
  const id = param(req, "id");
  if (id === userOf(req).id) throw badRequest("You cannot delete your own account");
  await prisma.user.delete({ where: { id } });
  res.status(204).end();
});

// ---- Schools ----
const schoolBody = z.object({ name: reqText(200), address: text(500).nullable().optional() });

adminRouter.get("/schools", async (_req, res) => {
  res.json(await prisma.school.findMany({ include: { _count: { select: { users: true, classrooms: true } } }, orderBy: { name: "asc" } }));
});
adminRouter.post("/schools", async (req, res) => {
  res.status(201).json(await prisma.school.create({ data: parse(schoolBody, req.body) }));
});
adminRouter.patch("/schools/:id", async (req, res) => {
  res.json(await prisma.school.update({ where: { id: param(req, "id") }, data: parse(schoolBody.partial(), req.body) }));
});
adminRouter.delete("/schools/:id", async (req, res) => {
  await prisma.school.delete({ where: { id: param(req, "id") } });
  res.status(204).end();
});

// ---- AI settings (keys stay in .env; we only report whether they exist) ----
adminRouter.get("/settings/ai", async (_req, res) => {
  const s = await getAiSettings();
  res.json({
    settings: s,
    keys: { openai: keyConfigured("openai"), gemini: keyConfigured("gemini") },
    models: { openai: env.openaiModel, gemini: env.geminiModel },
    demoMode: s.forceDemo || !keyConfigured(s.provider),
  });
});

adminRouter.put("/settings/ai", async (req, res) => {
  const s = parse(aiSettingsSchema, req.body);
  await setSetting("ai", s);
  res.json({ settings: s, demoMode: s.forceDemo || !keyConfigured(s.provider) });
});

// ---- Innovation showcase: real before/after evaluation (entered by admin) ----
adminRouter.put("/showcase/evaluation", async (req, res) => {
  const v = parse(evaluationSchema, req.body);
  await setSetting("showcase.evaluation", v);
  res.json(v);
});
