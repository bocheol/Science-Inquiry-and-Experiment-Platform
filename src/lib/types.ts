export type Role = "student" | "teacher";

export type SessionUser = {
  id: string;
  name: string;
  loginId: string;
  role: Role;
  academicYear: number;
  classId: string | null;
  classNumber: number | null;
  mustChangePassword: boolean;
};

export type MaterialItem = {
  name: string;
  specification: string;
  unitPrice: number;
  quantity: number;
  shipping: number;
  link: string;
};

export type PlanFormData = Record<string, unknown> & {
  field?: string;
  topic?: string;
};

export type JournalImage = {
  id: string;
  clientId: string;
  url: string;
};

export type ExperimentJournal = {
  id: string;
  sessionId: string;
  studentId: string;
  sessionNumber: number;
  date: string;
  activities: string;
  observations: string;
  reflections: string;
  images: JournalImage[];
  createdAt: string;
  updatedAt: string;
};

export type ReportFormData = Record<string, unknown> & {
  title?: string;
  purpose?: string;
  terms?: string;
  background?: string;
  researchPlanSchedule?: string;
  experimentMethod?: string;
  data?: string;
  analysis?: string;
  conclusion?: string;
  references?: string;
  appendix?: string;
};
