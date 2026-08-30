import { MATERIAL_BUDGET_WON } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { syncMaterialsToGoogleSheet } from "@/lib/google-sheets";
import { createId } from "@/lib/id";
import type { MaterialItem } from "@/lib/types";

export function materialTotal(items: MaterialItem[]) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity + item.shipping, 0);
}

export async function saveAndSyncMaterials(input: {
  submissionId: string;
  sessionId: string;
  teamId: string;
  actorId: string;
  items: MaterialItem[];
}) {
  const db = await getDb();
  const total = materialTotal(input.items);
  const budgetStatus = total > MATERIAL_BUDGET_WON ? "over_budget" : "within_budget";
  const requestId = createId("material");
  const savedRequest = await db.query<{ id: string }>(
    `INSERT INTO material_requests
      (id, submission_id, session_id, team_id, submitted_by, form_data, total_amount, budget_status, sync_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (submission_id) DO UPDATE
       SET form_data = EXCLUDED.form_data, total_amount = EXCLUDED.total_amount,
           budget_status = EXCLUDED.budget_status, sync_status = 'pending', sync_error = NULL,
           submitted_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [requestId, input.submissionId, input.sessionId, input.teamId, input.actorId, JSON.stringify(input.items), total, budgetStatus],
  );
  const savedRequestId = savedRequest.rows[0]?.id ?? requestId;
  const context = await db.query<{
    class_number: number;
    team_number: number;
    leader_name: string | null;
    leader_login_id: string | null;
  }>(
    `SELECT c.class_number, t.team_number, leader.name AS leader_name, leader.login_id AS leader_login_id
       FROM teams t JOIN classes c ON c.id = t.class_id
       LEFT JOIN users leader ON leader.id = t.leader_user_id
      WHERE t.id = $1 AND t.status = 'active'`,
    [input.teamId],
  );
  const team = context.rows[0];
  if (!team) throw new Error("팀 정보를 찾을 수 없습니다.");
  if (!team.leader_login_id || !team.leader_name) {
    await db.query("UPDATE material_requests SET sync_status = 'failed', sync_error = $1 WHERE submission_id = $2", ["교사가 팀장을 지정해야 합니다.", input.submissionId]);
    throw new Error("준비물 신청 전에 교사가 팀장을 지정해야 합니다.");
  }
  try {
    const synced = await syncMaterialsToGoogleSheet({
      classNumber: team.class_number,
      teamNumber: team.team_number,
      leaderLoginId: team.leader_login_id,
      leaderName: team.leader_name,
      items: input.items,
    });
    await db.query(
      "UPDATE material_requests SET sync_status = 'synced', sync_error = NULL, synced_at = CURRENT_TIMESTAMP WHERE submission_id = $1",
      [input.submissionId],
    );
    await audit(input.actorId, "materials_synced", "material_request", savedRequestId, synced);
    return { total, budgetStatus, syncStatus: "synced", syncError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Sheets 전송 실패";
    const pending = message.includes("연결 대기 중");
    await db.query(
      "UPDATE material_requests SET sync_status = $1, sync_error = $2 WHERE submission_id = $3",
      [pending ? "pending" : "failed", message, input.submissionId],
    );
    await audit(input.actorId, "materials_saved", "material_request", savedRequestId, { syncStatus: pending ? "pending" : "failed" });
    return { total, budgetStatus, syncStatus: pending ? "pending" : "failed", syncError: message };
  }
}

export async function retryMaterialSync(requestId: string, actorId: string) {
  const db = await getDb();
  const result = await db.query<{
    submission_id: string;
    session_id: string;
    team_id: string;
    submitted_by: string;
    form_data: MaterialItem[] | string;
  }>("SELECT submission_id, session_id, team_id, submitted_by, form_data FROM material_requests WHERE id = $1", [requestId]);
  const request = result.rows[0];
  if (!request) throw new Error("준비물 신청을 찾을 수 없습니다.");
  const items = typeof request.form_data === "string" ? JSON.parse(request.form_data) : request.form_data;
  return saveAndSyncMaterials({ submissionId: request.submission_id, sessionId: request.session_id, teamId: request.team_id, actorId, items });
}
