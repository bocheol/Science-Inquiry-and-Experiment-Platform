import { z } from "zod";

export const reportReviewExpectedSchema = z.object({
  cycleId: z.string().trim().min(1).max(200),
  version: z.number().int().nonnegative(),
  status: z.enum(["draft", "submitted", "feedback", "reviewed"]),
  feedback: z.string().max(10_000),
});
export type ReportReviewExpected = z.infer<typeof reportReviewExpectedSchema>;
export type ReportFeedbackDraft = { feedback: string; expected: ReportReviewExpected };
export function isReportFeedbackDraft(value: unknown): value is ReportFeedbackDraft {
  return z.object({ feedback: z.string().max(10_000), expected: reportReviewExpectedSchema }).safeParse(value).success;
}
