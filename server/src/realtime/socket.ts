import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { principalFromToken } from "../middleware/auth.js";
import type { Principal } from "../types.js";

let io: Server | null = null;

export const rooms = {
  user: (id: string) => `user:${id}`,
  group: (id: string) => `group:${id}`,
  teachers: (classroomId: string) => `classroom:${classroomId}:teachers`,
  groups: (classroomId: string) => `classroom:${classroomId}:groups`,
};

export function initSocket(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: "/socket.io",
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") return next(new Error("unauthorized"));
    const p = await principalFromToken(token);
    if (!p) return next(new Error("unauthorized"));
    socket.data.principal = p;
    next();
  });

  io.on("connection", (socket) => {
    const p = socket.data.principal as Principal;
    if (p.kind === "user") {
      socket.join(rooms.user(p.id));
      // Teachers subscribe to one classroom at a time on the Live Classroom page.
      socket.on("classroom:watch", async (classroomId: unknown, ack?: (r: { ok: boolean }) => void) => {
        if (typeof classroomId !== "string") return ack?.({ ok: false });
        const c = await prisma.classroom.findUnique({ where: { id: classroomId } });
        const allowed = !!c && (p.role === "ADMIN" || c.teacherId === p.id);
        if (!allowed) return ack?.({ ok: false });
        for (const r of socket.rooms) if (r.endsWith(":teachers")) socket.leave(r);
        socket.join(rooms.teachers(classroomId));
        ack?.({ ok: true });
      });
      socket.on("classroom:unwatch", () => {
        for (const r of socket.rooms) if (r.endsWith(":teachers")) socket.leave(r);
      });
    } else {
      socket.join(rooms.group(p.id));
      socket.join(rooms.groups(p.classroomId));
    }
  });

  return io;
}

/** Emit helper that is a no-op when Socket.IO is not initialised (e.g. scripts). */
export function emit(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

export function closeSocket() {
  return new Promise<void>((resolve) => (io ? io.close(() => resolve()) : resolve()));
}
