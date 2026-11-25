import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";

/** Generate a unique 6-digit group PIN. */
export async function generatePin(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    const exists = await prisma.group.findUnique({ where: { pin } });
    if (!exists) return pin;
  }
  throw new Error("Could not generate a unique PIN");
}
