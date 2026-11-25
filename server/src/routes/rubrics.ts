import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { badRequest, forbidden, notFound, param, parse, reqText, text } from "../lib/http.js";
import { requireUser, userOf } from "../middleware/auth.js";

export const rubricsRouter = Router();
rubricsRouter.use(requireUser("TEACHER", "ADMIN"));

const rubricBody = z.object({
  name: reqText(120),
  isDefault: z.boolean().default(false),
  criteria: z
    .array(
      z.object({
        id: z.string().optional(),
        name: reqText(80),
        description: text(300).default(""),
        maxScore: z.number().int().min(1).max(100),
        weight: z.number().min(0).max(100),
      }),
    )
    .min(1, "Add at least one criterion")
    .max(20),
});

async function ownedRubric(req: Parameters<typeof userOf>[0], id: string) {
  const u = userOf(req);
  const r = await prisma.rubric.findUnique({ where: { id } });
  if (!r) throw notFound("Rubric");
  if (u.role !== "ADMIN" && r.teacherId !== u.id) throw forbidden();
  return r;
}

rubricsRouter.get("/", async (req, res) => {
  const u = userOf(req);
  res.json(
    await prisma.rubric.findMany({
      where: u.role === "ADMIN" ? {} : { teacherId: u.id },
      include: { criteria: { orderBy: { order: "asc" } }, _count: { select: { assessments: true } } },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
  );
});

rubricsRouter.post("/", async (req, res) => {
  const u = userOf(req);
  const b = parse(rubricBody, req.body);
  if (b.criteria.reduce((s, c) => s + c.weight, 0) <= 0) throw badRequest("Total weight must be greater than 0");
  if (b.isDefault) await prisma.rubric.updateMany({ where: { teacherId: u.id }, data: { isDefault: false } });
  const r = await prisma.rubric.create({
    data: {
      name: b.name, isDefault: b.isDefault, teacherId: u.id,
      criteria: { create: b.criteria.map(({ id: _id, ...c }, i) => ({ ...c, order: i })) },
    },
    include: { criteria: { orderBy: { order: "asc" } } },
  });
  res.status(201).json(r);
});

/** Update criteria in place (keeps ids so existing scores stay linked). */
rubricsRouter.put("/:id", async (req, res) => {
  const r = await ownedRubric(req, param(req, "id"));
  const b = parse(rubricBody, req.body);
  if (b.criteria.reduce((s, c) => s + c.weight, 0) <= 0) throw badRequest("Total weight must be greater than 0");
  const updated = await prisma.$transaction(async (tx) => {
    if (b.isDefault) await tx.rubric.updateMany({ where: { teacherId: r.teacherId }, data: { isDefault: false } });
    const keep = b.criteria.filter((c) => c.id).map((c) => c.id!);
    await tx.rubricCriterion.deleteMany({ where: { rubricId: r.id, id: { notIn: keep } } });
    for (const [i, c] of b.criteria.entries()) {
      const data = { name: c.name, description: c.description, maxScore: c.maxScore, weight: c.weight, order: i };
      if (c.id) await tx.rubricCriterion.update({ where: { id: c.id }, data });
      else await tx.rubricCriterion.create({ data: { ...data, rubricId: r.id } });
    }
    return tx.rubric.update({
      where: { id: r.id },
      data: { name: b.name, isDefault: b.isDefault },
      include: { criteria: { orderBy: { order: "asc" } } },
    });
  });
  res.json(updated);
});

rubricsRouter.delete("/:id", async (req, res) => {
  const r = await ownedRubric(req, param(req, "id"));
  const used = await prisma.assessment.count({ where: { rubricId: r.id } });
  if (used) throw badRequest("This rubric is used by assessments and cannot be deleted");
  await prisma.rubric.delete({ where: { id: r.id } });
  res.status(204).end();
});
