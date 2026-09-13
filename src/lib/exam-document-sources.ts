import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { createPlanSubmission } from "@/lib/plan-snapshots";

type Form = Record<string, unknown>;
type Role = { userId: string; description: string };
export type ExamDocumentSource = {
  kind: "plan" | "report";
  id: string;
  cycleId: string | null;
  ordinal: number | null;
  legacy: boolean;
  form: Form;
  definition: Form;
  roles: Role[];
};
function json<T>(value: T | string | null, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

// All cycles in this inquiry are in scope. Only reviewed documents are eligible;
// current drafts never supply subject text or personal role evidence.
export async function getExamDocumentSources(sessionId: string, actorId: string): Promise<ExamDocumentSource[]> {
  const db = await getDb(), client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    const cycles = await client.query<{ id: string; ordinal: number }>("SELECT id, ordinal FROM inquiry_cycles WHERE session_id = $1 ORDER BY ordinal FOR UPDATE", [sessionId]);
    const plans = await client.query<{ id: string; cycle_id: string | null; review_status: string }>("SELECT id, cycle_id, review_status FROM investigation_plans WHERE session_id = $1 FOR UPDATE", [sessionId]);
    const plan = plans.rows[0];
    if (plan?.review_status === "approved") {
      const existing = await client.query("SELECT id FROM plan_submissions WHERE plan_id = $1 AND (cycle_id = $2 OR (cycle_id IS NULL AND $2::text IS NULL))", [plan.id, plan.cycle_id]);
      if (!existing.rows.length) {
        // Capture a known existing approval, without inventing an old approval date.
        const captured = await createPlanSubmission(client, plan.id, actorId, "legacy_capture");
        await client.query("UPDATE plan_submissions SET review_status = 'approved' WHERE id = $1", [captured.id]);
      }
    }
    const approved = await client.query<{
      id: string; cycle_id: string | null; ordinal: number | null; source: string;
      form_data: Form | string; config_definition: Form | string;
    }>(`SELECT d.id, d.cycle_id, c.ordinal, s.source, d.form_data, d.config_definition
          FROM plan_submissions s JOIN plan_document_snapshots d ON d.id = s.snapshot_id
          JOIN investigation_plans p ON p.id = s.plan_id
          LEFT JOIN inquiry_cycles c ON c.id = d.cycle_id AND c.session_id = p.session_id
         WHERE p.session_id = $1 AND s.review_status = 'approved'
         ORDER BY s.submission_number DESC`, [sessionId]);
    const documents: ExamDocumentSource[] = [];
    const seenPlans = new Set<string | null>();
    for (const row of approved.rows) {
      if (seenPlans.has(row.cycle_id)) continue;
      seenPlans.add(row.cycle_id);
      documents.push({ kind: "plan", id: row.id, cycleId: row.cycle_id, ordinal: row.ordinal, legacy: row.source === "legacy_capture", form: json(row.form_data, {}), definition: json(row.config_definition, {}), roles: [] });
    }
    if (plan) {
      const completedPlans = await client.query<{ id: string; cycle_id: string; ordinal: number; snapshot: { formData: Form; reviewStatus: string } | string }>(
        `SELECT d.id, d.cycle_id, c.ordinal, d.snapshot FROM document_revisions d
          JOIN inquiry_cycles c ON c.id = d.cycle_id AND c.session_id = $2
         WHERE d.document_type = 'plan' AND d.document_id = $1 AND d.action = 'cycle_completed'
         ORDER BY d.created_at DESC, d.id DESC`, [plan.id, sessionId]);
      for (const row of completedPlans.rows) {
        if (seenPlans.has(row.cycle_id)) continue;
        const snapshot = json(row.snapshot, { formData: {}, reviewStatus: "" });
        if (snapshot.reviewStatus !== "approved") continue;
        seenPlans.add(row.cycle_id);
        documents.push({ kind: "plan", id: row.id, cycleId: row.cycle_id, ordinal: row.ordinal, legacy: false, form: snapshot.formData, definition: {}, roles: [] });
      }
    }
    const reports = await client.query<{
      id: string; cycle_id: string | null; status: string; form_data: Form | string; config_version_id: string | null;
    }>("SELECT id, cycle_id, status, form_data, config_version_id FROM reports WHERE session_id = $1 FOR UPDATE", [sessionId]);
    const report = reports.rows[0];
    if (report?.status === "reviewed") {
      const form = { ...json(report.form_data, {}) };
      const fields = await client.query<{ field_key: string; value: string }>("SELECT field_key, value FROM report_fields WHERE report_id = $1 ORDER BY field_key", [report.id]);
      for (const field of fields.rows) form[field.field_key] = field.value;
      const roles = await client.query<{ user_id: string; role_description: string }>("SELECT user_id, role_description FROM report_member_roles WHERE report_id = $1 ORDER BY user_id", [report.id]);
      const definitions = report.config_version_id ? await client.query<{ definition: Form | string }>("SELECT definition FROM club_config_versions WHERE id = $1", [report.config_version_id]) : { rows: [] };
      const snapshot = { formData: form, status: "reviewed", teacherFeedback: null, roles: roles.rows.map(role => ({ userId: role.user_id, description: role.role_description })), configDefinition: json(definitions.rows[0]?.definition ?? null, {}) };
      const id = "exam_report_" + createHash("sha256").update(JSON.stringify([report.id, report.cycle_id, snapshot])).digest("hex").slice(0, 32);
      await client.query(`INSERT INTO document_revisions (id, document_type, document_id, cycle_id, snapshot, action, changed_by)
        VALUES ($1,'report',$2,$3,$4,'exam_evidence_capture',$5) ON CONFLICT (id) DO NOTHING`, [id, report.id, report.cycle_id, JSON.stringify(snapshot), actorId]);
      documents.push({ kind: "report", id, cycleId: report.cycle_id, ordinal: cycles.rows.find(cycle => cycle.id === report.cycle_id)?.ordinal ?? null, legacy: true, form, definition: snapshot.configDefinition, roles: snapshot.roles });
    }
    if (report) {
      const history = await client.query<{
        id: string; cycle_id: string | null; ordinal: number | null; action: string;
        snapshot: { formData: Form; status: string; roles: Role[]; configDefinition?: Form } | string;
      }>(`SELECT d.id, d.cycle_id, c.ordinal, d.action, d.snapshot FROM document_revisions d
           LEFT JOIN inquiry_cycles c ON c.id = d.cycle_id AND c.session_id = $2
          WHERE d.document_type = 'report' AND d.document_id = $1
            AND d.action IN ('teacher_review', 'exam_evidence_capture', 'cycle_completed')
          ORDER BY d.created_at DESC, d.id DESC`, [report.id, sessionId]);
      const seenReports = new Set(documents.filter(document => document.kind === "report").map(document => document.cycleId));
      for (const row of history.rows) {
        if (seenReports.has(row.cycle_id)) continue;
        const snapshot = json(row.snapshot, { formData: {}, status: "", roles: [] });
        if (row.action !== "teacher_review" && snapshot.status !== "reviewed") continue;
        // teacher_review stores the reviewed text immediately before changing its status,
        // in the same transaction. Roles retain original user IDs, never alias order.
        seenReports.add(row.cycle_id);
        documents.push({ kind: "report", id: row.id, cycleId: row.cycle_id, ordinal: row.ordinal, legacy: row.action === "exam_evidence_capture", form: snapshot.formData, definition: snapshot.configDefinition ?? {}, roles: snapshot.roles ?? [] });
      }
    }
    await client.query("COMMIT");
    return documents.sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
