import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { forbidden, notFound, unauthorized } from "../lib/http.js";
import type { Role } from "../lib/constants.js";
import type { Principal } from "../types.js";

type TokenPayload =
  | { typ: "user"; sub: string; role: Role }
  | { typ: "group"; sub: string; cid: string };

export function signUserToken(user: { id: string; role: string }) {
  return jwt.sign({ typ: "user", role: user.role }, env.jwtSecret, { subject: user.id, expiresIn: "12h" });
}

export function signGroupToken(group: { id: string; classroomId: string }) {
  return jwt.sign({ typ: "group", cid: group.classroomId }, env.jwtSecret, { subject: group.id, expiresIn: "12h" });
}

/** Verify a token and load the principal from the DB (so deactivated users / regenerated PINs lose access). */
export async function principalFromToken(token: string): Promise<Principal | null> {
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.typ === "user") {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return null;
    return { kind: "user", id: user.id, role: user.role as Role, name: user.name };
  }
  if (payload.typ === "group") {
    const group = await prisma.group.findUnique({ where: { id: payload.sub } });
    if (!group || group.classroomId !== payload.cid) return null;
    return { kind: "group", id: group.id, classroomId: group.classroomId, name: group.name };
  }
  return null;
}

function bearer(req: Request) {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Attach req.auth when a valid token is present. Does not reject. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (token) req.auth = (await principalFromToken(token)) ?? undefined;
  next();
}

export function requireUser(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) return next(unauthorized());
    if (a.kind !== "user") return next(forbidden("This action is for teachers or administrators"));
    if (roles.length && !roles.includes(a.role)) return next(forbidden());
    next();
  };
}

export function requireGroup(req: Request, _res: Response, next: NextFunction) {
  const a = req.auth;
  if (!a) return next(unauthorized());
  if (a.kind !== "group") return next(forbidden("This action is for student groups"));
  next();
}

export function userOf(req: Request) {
  const a = req.auth;
  if (!a || a.kind !== "user") throw unauthorized();
  return a;
}

export function groupOf(req: Request) {
  const a = req.auth;
  if (!a || a.kind !== "group") throw unauthorized();
  return a;
}

/** Load a classroom the current teacher owns (admins can access all). */
export async function ownedClassroom(req: Request, classroomId: string) {
  const u = userOf(req);
  const c = await prisma.classroom.findUnique({ where: { id: classroomId } });
  if (!c) throw notFound("Classroom");
  if (u.role !== "ADMIN" && c.teacherId !== u.id) throw forbidden();
  return c;
}

export async function ownedGroup(req: Request, groupId: string) {
  const g = await prisma.group.findUnique({ where: { id: groupId } });
  if (!g) throw notFound("Group");
  await ownedClassroom(req, g.classroomId);
  return g;
}

export async function ownedSession(req: Request, sessionId: string) {
  const s = await prisma.classroomSession.findUnique({ where: { id: sessionId } });
  if (!s) throw notFound("Session");
  await ownedClassroom(req, s.classroomId);
  return s;
}

export async function ownedLesson(req: Request, lessonId: string) {
  const u = userOf(req);
  const l = await prisma.lesson.findUnique({ where: { id: lessonId } });
  if (!l) throw notFound("Lesson");
  if (u.role !== "ADMIN" && l.teacherId !== u.id) throw forbidden();
  return l;
}
