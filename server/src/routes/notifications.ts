import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { param } from "../lib/http.js";
import { requireUser, userOf } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireUser("TEACHER", "ADMIN"));

notificationsRouter.get("/", async (req, res) => {
  const u = userOf(req);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: u.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.notification.count({ where: { userId: u.id, readAt: null } }),
  ]);
  res.json({ items, unread });
});

notificationsRouter.post("/read-all", async (req, res) => {
  const u = userOf(req);
  await prisma.notification.updateMany({ where: { userId: u.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

notificationsRouter.post("/:id/read", async (req, res) => {
  const u = userOf(req);
  await prisma.notification.updateMany({ where: { id: param(req, "id"), userId: u.id }, data: { readAt: new Date() } });
  res.json({ ok: true });
});
