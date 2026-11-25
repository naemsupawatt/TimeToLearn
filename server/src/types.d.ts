import type { Role } from "./lib/constants.js";

export type Principal =
  | { kind: "user"; id: string; role: Role; name: string }
  | { kind: "group"; id: string; classroomId: string; name: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Principal;
    }
  }
}

export {};
