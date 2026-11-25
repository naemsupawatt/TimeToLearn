import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "node:fs";
import { env } from "./env.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { classroomsRouter } from "./routes/classrooms.js";
import { lessonsRouter } from "./routes/lessons.js";
import { sessionsRouter } from "./routes/sessions.js";
import { studentRouter } from "./routes/student.js";
import { rubricsRouter } from "./routes/rubrics.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { notificationsRouter } from "./routes/notifications.js";
import { showcaseRouter } from "./routes/showcase.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Uploaded images (random file names). Served read-only.
  fs.mkdirSync(env.uploadDir, { recursive: true });
  app.use(
    "/uploads",
    express.static(env.uploadDir, {
      index: false,
      dotfiles: "deny",
      setHeaders: (res) => res.setHeader("Cache-Control", "private, max-age=3600"),
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api", authenticate);
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/classrooms", classroomsRouter);
  app.use("/api/lessons", lessonsRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/rubrics", rubricsRouter);
  app.use("/api/assessments", assessmentsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/student", studentRouter);
  app.use("/api/showcase", showcaseRouter);

  app.use("/api", notFoundHandler);
  app.use(errorHandler);
  return app;
}
