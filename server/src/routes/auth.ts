import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { HttpError, parse, unauthorized } from "../lib/http.js";
import { signGroupToken, signUserToken } from "../middleware/auth.js";
import { activeSessionFor, displayName } from "../services/live.js";

export const authRouter = Router();

// Brute-force protection for passwords and 6-digit PINs.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY", message: "Too many attempts. Please wait a few minutes." } },
  skip: () => process.env.NODE_ENV === "test",
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email }, include: { school: true } });
  // Same message for unknown email and wrong password.
  if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw unauthorized("Incorrect email or password");
  if (!user.active) throw new HttpError(403, "This account is disabled. Contact the administrator.", "DISABLED");
  res.json({
    token: signUserToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, school: user.school?.name ?? null },
  });
});

authRouter.post("/group-login", loginLimiter, async (req, res) => {
  const { pin } = parse(z.object({ pin: z.string().trim().regex(/^\d{6}$/, "PIN must be 6 digits") }), req.body);
  const group = await prisma.group.findUnique({
    where: { pin },
    include: { classroom: true, members: { include: { student: true } } },
  });
  if (!group) throw unauthorized("PIN not found. Please check with your teacher.");
  const session = await activeSessionFor(group.classroomId);
  res.json({
    token: signGroupToken(group),
    group: {
      id: group.id,
      name: group.name,
      color: group.color,
      classroom: group.classroom.name,
      members: group.members.map((m) => displayName(m.student)),
      hasActiveSession: !!session,
    },
  });
});

authRouter.get("/me", async (req, res) => {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (a.kind === "user") {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: a.id }, include: { school: true } });
    return res.json({ kind: "user", user: { id: user.id, name: user.name, email: user.email, role: user.role, school: user.school?.name ?? null } });
  }
  const group = await prisma.group.findUniqueOrThrow({ where: { id: a.id }, include: { classroom: true } });
  res.json({ kind: "group", group: { id: group.id, name: group.name, color: group.color, classroom: group.classroom.name } });
});
