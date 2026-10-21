import { createHash } from "node:crypto";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { assertRecordEvidenceAccess, assertRecordStudent, parseValue, type RecordActor, type RecordDb } from "./access";
import { COURSE_TWO_GROUPS, RECORD_ACTIVITIES, type ActivityId, type EvidenceBundle, type RecordEvidence } from "./model";

function readable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.entries(value).map(([key, text]) => readable(text) ? key + ": " + readable(text) : "").filter(Boolean).join("\n");
  return String(value);
}

export async function collectRecordEvidence(db: RecordDb, actor: RecordActor, studentId: string): Promise<EvidenceBundle> {
  await assertRecordStudent(db, actor, studentId);
  const submission = (await db.query<{ selected: ActivityId[]; comments: Partial<Record<ActivityId, string>> }>("SELECT selected, comments FROM record_submissions WHERE student_id = $1", [studentId])).rows[0];
  const selected = parseValue(submission?.selected ?? []);
  const comments = parseValue(submission?.comments ?? {});
  const sources: RecordEvidence[] = [];
  const add = (source: RecordEvidence) => { if (source.text.trim() && !sources.some(s => s.id === source.id)) sources.push(source); };
  for (const activity of RECORD_ACTIVITIES) {
    if (activity.course === 1 && !selected.includes(activity.id)) continue;
    if (comments[activity.id]) add({ id: "statement:" + activity.id, course: activity.course, activity: activity.id, label: activity.label + " · 학생의 추가 설명", text: comments[activity.id]!, kind: "student_statement", confirmed: false, sourceUrl: "/records?student=" + encodeURIComponent(studentId) });
  }
  const files = (await db.query<{ id: string; activity: ActivityId; course: 1 | 2; file_name: string; extracted_text: string; extraction_status: string }>(
    "SELECT id, activity, course, file_name, extracted_text, extraction_status FROM record_files WHERE student_id = $1 AND included = TRUE ORDER BY created_at, id", [studentId])).rows;
  for (const file of files) {
    if (file.course === 1 && !selected.includes(file.activity)) continue;
    add({ id: "file:" + file.id, course: file.course, activity: file.activity, label: file.file_name,
      text: file.extracted_text, kind: file.activity === "individual_plan" || file.activity === "team_plan" ? "plan" : "individual_record",
      sourceUrl: "/api/records/files/" + encodeURIComponent(file.id), confirmed: file.extraction_status === "ready" });
  }
  const sessions = (await db.query<{ id: string; team_id: string; name: string; joined_at: Date; left_at: Date | null }>(
    `SELECT s.id, s.team_id, t.name, m.joined_at, m.left_at FROM team_members m JOIN teams t ON t.id = m.team_id
     JOIN classes c ON c.id = t.class_id JOIN inquiry_sessions s ON s.team_id = t.id
     WHERE m.user_id = $1 AND c.academic_year = $2 ORDER BY m.joined_at, s.id`, [studentId, ACADEMIC_YEAR])).rows;
  for (const session of sessions) {
    const currentPlanCycle = (await db.query<{ cycle_id: string }>("SELECT cycle_id FROM investigation_plans WHERE session_id = $1", [session.id])).rows[0]?.cycle_id;
    const currentReportCycle = (await db.query<{ cycle_id: string }>("SELECT cycle_id FROM reports WHERE session_id = $1", [session.id])).rows[0]?.cycle_id;
    // Revisions retain past cycles and the student's old membership. A later team
    // version is never attributed to a student who already left the team.
    const revisions = (await db.query<{ id: string; document_type: string; cycle_id: string | null; snapshot: { formData: unknown; roles?: { userId: string; description: string }[] }; created_at: Date }>(
      `SELECT r.id, r.document_type, r.cycle_id, r.snapshot, r.created_at FROM document_revisions r
       JOIN inquiry_cycles c ON c.id = r.cycle_id WHERE c.session_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [session.id])).rows;
    const seen = new Set<string>();
    for (const revision of revisions) {
      if (session.left_at && new Date(revision.created_at) > new Date(session.left_at)) continue;
      if (new Date(revision.created_at) < new Date(session.joined_at)) continue;
      const key = revision.document_type + ":" + revision.cycle_id;
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = parseValue(revision.snapshot);
      const activity = revision.document_type === "plan" ? "team_plan" : "team_report";
      const ownRole = snapshot.roles?.find(r => r.userId === studentId)?.description;
      add({ id: "revision:" + revision.id, course: 2, activity, label: session.name + " · " + (activity === "team_plan" ? "팀 계획서" : "팀 보고서"), text: readable(snapshot.formData) + (ownRole ? "\n이 학생이 기록한 역할: " + ownRole : ""), kind: activity === "team_plan" ? "plan" : "team_document", confirmed: true, sourceUrl: "/teacher/team/" + session.team_id });
    }
    // Older cycles may survive only as immutable snapshots. Select only public
    // document columns: never import the snapshots' all-student journals.
    const planSnapshots = (await db.query<{ id: string; cycle_id: string; form_data: unknown; document_updated_at: Date }>(
      `SELECT p.id, p.cycle_id, p.form_data, p.document_updated_at FROM plan_document_snapshots p
       JOIN inquiry_cycles c ON c.id = p.cycle_id WHERE c.session_id = $1 ORDER BY p.document_updated_at DESC, p.id DESC`, [session.id])).rows;
    for (const snapshot of planSnapshots) {
      if (!session.left_at && snapshot.cycle_id === currentPlanCycle) continue;
      const key = "plan:" + snapshot.cycle_id;
      if (seen.has(key) || new Date(snapshot.document_updated_at) < new Date(session.joined_at) || (session.left_at && new Date(snapshot.document_updated_at) > new Date(session.left_at))) continue;
      seen.add(key);
      add({ id: "plan-snapshot:" + snapshot.id, course: 2, activity: "team_plan", label: session.name + " · 이전 회차 계획서", text: readable(parseValue(snapshot.form_data)), kind: "plan", confirmed: true, sourceUrl: "/teacher/team/" + session.team_id });
    }
    const reportSnapshots = (await db.query<{ id: string; cycle_id: string; report_form_data: unknown; created_at: Date }>(
      "SELECT id, cycle_id, report_form_data, created_at FROM cycle_evidence_snapshots WHERE session_id = $1 ORDER BY created_at DESC, id DESC", [session.id])).rows;
    for (const snapshot of reportSnapshots) {
      if (!session.left_at && snapshot.cycle_id === currentReportCycle) continue;
      const key = "report:" + snapshot.cycle_id;
      if (seen.has(key) || new Date(snapshot.created_at) < new Date(session.joined_at) || (session.left_at && new Date(snapshot.created_at) > new Date(session.left_at))) continue;
      seen.add(key);
      add({ id: "report-snapshot:" + snapshot.id, course: 2, activity: "team_report", label: session.name + " · 이전 회차 팀 보고서 (개인 역할 별도 확인)", text: readable(parseValue(snapshot.report_form_data)), kind: "team_document", confirmed: true, sourceUrl: "/teacher/team/" + session.team_id });
    }
    if (!session.left_at) {
      for (const [table, activity, kind] of [["investigation_plans", "team_plan", "plan"], ["reports", "team_report", "team_document"]] as const) {
        const documents = (await db.query<{ id: string; cycle_id: string | null; form_data: unknown }>("SELECT id, cycle_id, form_data FROM " + table + " WHERE session_id = $1", [session.id])).rows;
        for (const doc of documents) {
          // The current saved document can be newer than its latest revision.
          const prior = sources.findIndex(s => revisions.some(r => s.id === "revision:" + r.id && r.document_type === (activity === "team_plan" ? "plan" : "report") && r.cycle_id === doc.cycle_id));
          if (prior >= 0) sources.splice(prior, 1);
          const form = { ...parseValue(doc.form_data as Record<string, unknown>) };
          let role = "";
          if (activity === "team_report") {
            for (const field of (await db.query<{ field_key: string; value: string }>("SELECT field_key, value FROM report_fields WHERE report_id = $1", [doc.id])).rows) form[field.field_key] = field.value;
            role = (await db.query<{ role_description: string }>("SELECT role_description FROM report_member_roles WHERE report_id = $1 AND user_id = $2", [doc.id, studentId])).rows[0]?.role_description ?? "";
          }
          add({ id: activity + ":" + doc.id, course: 2, activity, label: session.name + " · " + (activity === "team_plan" ? "팀 계획서" : "팀 보고서"), text: readable(form) + (role ? "\n이 학생이 기록한 역할: " + role : ""), kind, confirmed: true, sourceUrl: "/teacher/team/" + session.team_id });
        }
      }
    }
  }
  const journals = (await db.query<{ id: string; journal_date: string; activities: string; observations: string; reflections: string }>(
    `SELECT j.id, j.journal_date, j.activities, j.observations, j.reflections FROM experiment_journals j
     JOIN inquiry_sessions s ON s.id = j.session_id JOIN teams t ON t.id = s.team_id JOIN classes c ON c.id = t.class_id
     LEFT JOIN class_journal_teacher_assignments a ON a.class_id = c.id AND a.teacher_id = $3
     WHERE j.student_id = $1 AND c.academic_year = $2 AND ($4 = 'student' OR a.teacher_id IS NOT NULL)
     ORDER BY j.journal_date, j.id`, [studentId, ACADEMIC_YEAR, actor.id, actor.role])).rows;
  let photoCount = 0;
  for (const j of journals) {
    const images = (await db.query<{ id: string; file_name: string }>("SELECT id, file_name FROM experiment_journal_images WHERE journal_id = $1 ORDER BY id", [j.id])).rows;
    photoCount += images.length;
    add({ id: "journal:" + j.id, course: 2, activity: "journal", label: "본인 일지 · " + new Date(j.journal_date).toISOString().slice(0, 10), text: "활동: " + j.activities + "\n관찰: " + j.observations + "\n성찰: " + j.reflections + (images.length ? "\n첨부 사진 " + images.length + "장: AI가 사진 내용을 판독하지 않았으므로 교사 확인 필요." : ""), kind: "individual_record", confirmed: true, sourceUrl: "/records?student=" + encodeURIComponent(studentId), attachments: images.map(image => ({ label: image.file_name, url: "/api/records/journal-images/" + image.id })) });
  }
  const ownMessages = (await db.query<{ id: string; content: string }>(
    `SELECT m.id, m.content FROM messages m JOIN inquiry_sessions s ON s.id = m.session_id
     JOIN teams t ON t.id = s.team_id JOIN classes c ON c.id = t.class_id
     WHERE m.sender_id = $1 AND m.role = 'user' AND c.academic_year = $2 ORDER BY m.created_at, m.id`, [studentId, ACADEMIC_YEAR])).rows;
  for (const message of ownMessages) add({ id: "own-message:" + message.id, course: 2, activity: "team_report", label: "본인이 남긴 탐구 질문·의견", text: message.content, kind: "discussion", confirmed: true, sourceUrl: "/records?student=" + encodeURIComponent(studentId) });
  const ownDiscussions = (await db.query<{ id: string; content: string; kind: string }>(
    `SELECT d.id, d.content, d.kind FROM discussion_entries d JOIN inquiry_sessions s ON s.id = d.session_id
     JOIN teams t ON t.id = s.team_id JOIN classes c ON c.id = t.class_id
     WHERE d.author_id = $1 AND c.academic_year = $2 ORDER BY d.created_at, d.id`, [studentId, ACADEMIC_YEAR])).rows;
  for (const discussion of ownDiscussions) add({ id: "own-discussion:" + discussion.id, course: 2, activity: "team_report", label: discussion.kind === "meeting" ? "본인이 기록한 팀 회의 (공동 발언 구분 필요)" : "본인이 남긴 팀 토의", text: discussion.content, kind: "discussion", confirmed: true, sourceUrl: "/records?student=" + encodeURIComponent(studentId) });
  const exams = (await db.query<{ id: string; title: string; teacher_feedback: string }>(
    `SELECT e.id, es.title, r.teacher_feedback FROM exams e JOIN exam_sets es ON es.id = e.exam_set_id
     JOIN classes c ON c.id = es.class_id JOIN exam_results r ON r.exam_id = e.id
     WHERE e.student_id = $1 AND c.academic_year = $2 ORDER BY e.id`, [studentId, ACADEMIC_YEAR])).rows;
  for (const exam of exams) add({ id: "exam-feedback:" + exam.id, course: 2, activity: "exam", label: exam.title + " · 교사 피드백 (답안 원문 아님)", text: exam.teacher_feedback, kind: "exam_feedback", confirmed: true, sourceUrl: "/teacher/exams" });
  const missing = COURSE_TWO_GROUPS.filter(group => !sources.some(s => s.activity === group && s.confirmed && s.kind !== "student_statement" && s.kind !== "exam_feedback" && s.kind !== "discussion")).map(group => RECORD_ACTIVITIES.find(a => a.id === group)!.label + " 원문 없음 또는 추출 확인 대기");
  if (photoCount) missing.push("본인 일지 사진 " + photoCount + "장: 원본을 열어 별도 확인 필요 (AI 미판독)");
  for (const id of selected) if (!sources.some(s => s.activity === id && s.confirmed)) missing.push(RECORD_ACTIVITIES.find(a => a.id === id)!.label + "은 학생 설명만 있거나 원문 확인 대기");
  sources.sort((a, b) => a.id.localeCompare(b.id));
  await assertRecordEvidenceAccess(db, actor, studentId, { sources });
  return { sources, missing, hash: createHash("sha256").update(JSON.stringify({ sources, missing })).digest("hex"), collectedAt: new Date().toISOString() };
}
