export const ROLES = ["ADMIN", "TEACHER"] as const;
export type Role = (typeof ROLES)[number];

/** The 7-phase Active Learning process. */
export const PHASES = ["MISSION", "THINK", "BUILD", "CODING", "TEST", "IMPROVE", "REFLECTION"] as const;
export type Phase = (typeof PHASES)[number];

export const GROUP_STATUSES = ["NOT_STARTED", "LEARNING", "WAITING_REVIEW", "NEED_HELP", "COMPLETED"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export const HELP_CATEGORIES = ["BUILD", "CODING", "EQUIPMENT", "MISSION", "OTHER"] as const;
export const HELP_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;

export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export const LESSON_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export const SUBMISSION_STATUSES = ["SUBMITTED", "APPROVED", "NEEDS_WORK"] as const;
export const GROUP_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "teal", "pink"] as const;

export const DEFAULT_RUBRIC = [
  { name: "Knowledge", description: "เข้าใจหลักการทำงานของหุ่นยนต์และเซนเซอร์" },
  { name: "Coding Skills", description: "เขียนและแก้ไขโปรแกรมควบคุมหุ่นยนต์ได้" },
  { name: "Engineering Design", description: "ออกแบบและประกอบโครงสร้างได้เหมาะสม" },
  { name: "Problem Solving", description: "วิเคราะห์ปัญหาและทดลองหาทางแก้" },
  { name: "Creativity", description: "มีแนวคิดใหม่หรือปรับปรุงผลงานอย่างสร้างสรรค์" },
  { name: "Teamwork", description: "ทำงานร่วมกับสมาชิกในกลุ่มอย่างมีส่วนร่วม" },
] as const;
