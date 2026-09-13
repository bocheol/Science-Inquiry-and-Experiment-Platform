import { MATERIAL_BUDGET_WON } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { SPREADSHEET_ID } from "@/lib/google-sheets";
import { executeMaterialSheetTransfer, prepareMaterialSheetTransfer, type MaterialSheetBatch, type MaterialSheetSnapshot } from "@/lib/material-sheet-transfer";
import { createId } from "@/lib/id";
import type { MaterialItem } from "@/lib/types";
import type { PoolClient } from "pg";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";
import { UserFacingError, userFacingMessage } from "@/lib/user-facing-error";

export function materialTotal(items: MaterialItem[]) {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity + item.shipping, 0);
}
function sameMaterialItems(left: MaterialItem[], right: MaterialItem[]) {
  const keys = ["name", "specification", "unitPrice", "quantity", "shipping", "link"] as const;
  return left.length === right.length && left.every((item, index) => keys.every(key => item[key] === right[index][key]));
}
export function resolveClubSheetTab(teamName: string, sheetNames: string[]) {
  const names = [...new Set(sheetNames.map(name => name.trim()).filter(Boolean))];
  if (names.length === 1) return names[0];
  const matched = names.filter(name => teamName === name || teamName.includes(`(${name})`));
  if (matched.length === 1) return matched[0];
  throw new UserFacingError(`팀 이름 '${teamName}'과 일치하는 운영 탭을 하나만 지정해 주세요.`);
}
const parse = <T,>(value: T | string): T => typeof value === "string" ? JSON.parse(value) : value;
type RequestRow = {
  id: string; submission_id: string; team_id: string; session_id: string; cycle_id: string | null; submitted_by: string; config_version_id: string | null;
  form_data: MaterialItem[] | string; total_amount: number; budget_status: string; sync_status: string;
  sync_snapshot: MaterialSheetSnapshot | string | null; sync_operation_id: string | null; sync_batch: MaterialSheetBatch | string | null;
};
type Input = { submissionId: string; sessionId: string; cycleId?: string; teamId: string; actorId: string; items: MaterialItem[] };
const result = (row: RequestRow, syncStatus: string, syncError: string | null = null) => ({ total: row.total_amount, budgetStatus: row.budget_status, syncStatus, syncError });
const conflict = () => new UserFacingError("준비물 신청이 변경되었거나 이전 전송 확인이 필요합니다. 작성 내용은 유지되며, 담당 교사가 재전송 상태를 확인한 뒤 다시 제출해 주세요.");
const demoMessage = "교사용 학생 계정의 연습 제출은 Google Sheet에 반영하지 않습니다.";

export async function saveAndSyncMaterials(input: Input, retry = false) {
  const client = await (await getDb()).connect();
  let prepared: { saved: RequestRow; demo: boolean };
  try {
    await client.query("BEGIN");
    prepared = await prepareMaterialRequest(client, input, retry);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  if (prepared.saved.sync_status === "synced") return result(prepared.saved, "synced");
  if (prepared.demo) return result(prepared.saved, "pending", demoMessage);
  return sendSavedMaterials(prepared.saved, input.actorId);
}

async function lockMaterialActor(client: PoolClient, actorId: string, teamId: string) {
  await lockStudentsTeams(client, [actorId], [teamId]);
  const user = (await client.query<{ role: string }>("SELECT role FROM users WHERE id = $1 AND status = 'active' AND must_change_password = FALSE", [actorId])).rows[0];
  if (!user || !["student", "teacher"].includes(user.role)) throw new UserFacingError("현재 계정으로 준비물 신청을 변경할 권한이 없습니다.");
  if (user.role === "student" && !(await client.query("SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active'", [actorId, teamId])).rows.length) throw new UserFacingError("현재 팀 자료에 접근할 수 없습니다.");
  if (!(await client.query("SELECT id FROM teams WHERE id = $1 AND status = 'active'", [teamId])).rows.length) throw new UserFacingError("활성 팀의 준비물 신청만 변경할 수 있습니다.");
}

async function prepareMaterialRequest(db: PoolClient, input: Input, retry: boolean): Promise<{ saved: RequestRow; demo: boolean }> {
  // Fix the cycle, actor membership and team before reading the destination or
  // saving a request. Network preparation/transmission happens after commit.
  await db.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [input.sessionId]);
  const activeCycle = await db.query<{ id: string }>(
    "SELECT id FROM inquiry_cycles WHERE session_id = $1 AND status = 'active' ORDER BY ordinal DESC LIMIT 1 FOR UPDATE", [input.sessionId],
  );
  const cycleId = activeCycle.rows[0]?.id;
  if (!cycleId) throw new UserFacingError("현재 진행 중인 탐구 회차를 찾을 수 없습니다.");
  if (input.cycleId !== undefined && input.cycleId !== cycleId) throw new UserFacingError("탐구 회차가 변경되었습니다. 작성 내용을 보관하고 현재 회차를 다시 확인해 주세요.");
  await lockMaterialActor(db, input.actorId, input.teamId);
  let saved = (await db.query<RequestRow>("SELECT * FROM material_requests WHERE submission_id = $1", [input.submissionId])).rows[0];
  if (saved && (saved.team_id !== input.teamId || saved.session_id !== input.sessionId)) throw new UserFacingError("이 준비물 신청을 변경할 권한이 없습니다.");
  const team = (await db.query<{
    class_number: number | null; team_number: number; team_name: string; club_id: string | null;
    leader_name: string | null; leader_login_id: string | null; actor_account_type: string;
  }>(`SELECT c.class_number, t.team_number, t.name AS team_name, t.club_id,
      leader.name AS leader_name, leader.login_id AS leader_login_id, actor.account_type AS actor_account_type
      FROM teams t JOIN inquiry_sessions s ON s.team_id = t.id AND s.id = $3
      LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN users leader ON leader.id = t.leader_user_id
      JOIN users actor ON actor.id = $2 WHERE t.id = $1 AND t.status = 'active'`, [input.teamId, input.actorId, input.sessionId])).rows[0];
  if (!team) throw new UserFacingError("팀 정보를 찾을 수 없습니다.");
  if (saved && saved.cycle_id !== cycleId) throw new UserFacingError("이 준비물 신청을 변경할 권한이 없습니다.");
  const identical = saved && sameMaterialItems(parse(saved.form_data), input.items);
  if (retry && !identical) throw new UserFacingError("재전송 중 신청 내용이 변경되었습니다. 최신 신청을 확인하고 다시 시도해 주세요.");
  const submitter = saved ? (await db.query<{ account_type: string }>("SELECT account_type FROM users WHERE id = $1", [saved.submitted_by])).rows[0] : { account_type: team.actor_account_type };
  if (!submitter) throw new UserFacingError("원래 제출자 정보를 확인할 수 없습니다.");
  if (saved && team.actor_account_type === "demo" && submitter.account_type !== "demo") throw new UserFacingError("체험 계정으로 일반 학생의 준비물 신청을 변경할 수 없습니다.");
  if (identical && saved.sync_status === "synced") return { saved, demo: false };
  const demo = team.actor_account_type === "demo" || submitter.account_type === "demo";
  if (saved && !saved.sync_snapshot && !demo) throw new UserFacingError("제출 당시 전송 위치·완료 기록을 확인할 수 없습니다. 중복 방지를 위해 담당 교사가 기존 시트와 신청을 먼저 대조해야 합니다.");
  if (saved && !identical && saved.sync_status !== "synced" && !demo) throw conflict();
  let configVersionId = saved?.config_version_id ?? null;
  let snapshot = saved?.sync_snapshot ? parse(saved.sync_snapshot) : null;
  if (!snapshot && !demo) {
    if (!team.leader_login_id || !team.leader_name) throw new UserFacingError("준비물 신청 전에 교사가 팀장을 지정해야 합니다.");
    snapshot = { spreadsheetId: SPREADSHEET_ID, sheetName: `${team.class_number}반`, layout: "team_sections",
      teamNumber: team.team_number, teamName: team.team_name, leaderLoginId: team.leader_login_id, leaderName: team.leader_name,
      targetKey: `${input.sessionId}:${cycleId}`, submittedAt: new Date().toISOString(), items: input.items };
    if (team.club_id) {
      const config = (await db.query<{ id: string; definition: { sheet?: {
        spreadsheetId?: string; sheetName?: string; sheetNames?: string[]; layout?: "header_row" | "team_sections"; columnMapping?: Record<string, string>;
      } } | string }>(`SELECT id, definition FROM club_config_versions WHERE club_id = $1 AND config_type = 'materials'
        AND config_key = 'default' AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [team.club_id])).rows[0];
      const sheet = config && parse(config.definition).sheet;
      if (!sheet?.spreadsheetId || !sheet.sheetName) throw new UserFacingError("담당 교사가 준비물 설정을 발행한 뒤 이용할 수 있습니다.");
      configVersionId = config.id;
      snapshot = { ...snapshot, spreadsheetId: sheet.spreadsheetId,
        sheetName: resolveClubSheetTab(team.team_name, sheet.sheetNames?.length ? sheet.sheetNames : sheet.sheetName.split(",")),
        layout: sheet.layout ?? "header_row", columnMapping: sheet.columnMapping,
        teamNumber: Number(/^\s*(\d+)\s*조/.exec(team.team_name)?.[1] ?? team.team_number) };
      if (snapshot.layout === "header_row") {
        const legacy = await db.query("SELECT id FROM material_requests WHERE cycle_id = $1 AND sync_snapshot IS NULL LIMIT 1", [cycleId]);
        if (legacy.rows.length) throw new UserFacingError("기존 신청의 시트 위치를 먼저 대조해야 합니다. 중복 행을 만들지 않도록 담당 교사에게 확인을 요청해 주세요.");
      }
    }
  }
  if (!identical || !saved) {
    const operationId = createId("material_send");
    if (snapshot) snapshot = { ...snapshot, items: input.items, submittedAt: new Date().toISOString(), previousOperationId: saved?.sync_operation_id ?? undefined };
    const total = materialTotal(input.items);
    const client = db;
    const values = [JSON.stringify(input.items), total, total > MATERIAL_BUDGET_WON ? "over_budget" : "within_budget", snapshot ? JSON.stringify(snapshot) : null, operationId];
    const write = saved ? await client.query<RequestRow>(`UPDATE material_requests SET form_data = $1, total_amount = $2,
      budget_status = $3, sync_snapshot = $4, sync_operation_id = $5, sync_batch = NULL, sync_status = 'pending', sync_error = NULL, submitted_at = CURRENT_TIMESTAMP
      WHERE id = $6 AND form_data = $7::jsonb AND (sync_operation_id = $8 OR (sync_operation_id IS NULL AND $8::text IS NULL)) RETURNING *`,
    [...values, saved.id, JSON.stringify(parse(saved.form_data)), saved.sync_operation_id]) : await client.query<RequestRow>(`INSERT INTO material_requests
      (form_data, total_amount, budget_status, sync_snapshot, sync_operation_id, id, submission_id, session_id, cycle_id, team_id, submitted_by, config_version_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (submission_id) DO NOTHING RETURNING *`,
    [...values, createId("material"), input.submissionId, input.sessionId, cycleId, input.teamId, input.actorId, configVersionId]);
    if (!write.rows[0]) throw conflict();
    saved = write.rows[0];
    if (!demo && snapshot) {
      const claim = await client.query(`INSERT INTO material_sheet_dispatch (spreadsheet_id, operation_id, request_id) VALUES ($1,$2,$3)
        ON CONFLICT (spreadsheet_id) DO NOTHING RETURNING operation_id`, [snapshot.spreadsheetId, operationId, saved.id]);
      if (!claim.rows.length) throw conflict();
    }
  }
  if (demo) {
    await db.query("UPDATE material_requests SET sync_error = $1 WHERE id = $2", [demoMessage, saved.id]);
  }
  return { saved, demo };
}

async function lockMaterialResult(client: PoolClient, saved: RequestRow) {
  await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [saved.session_id]);
  const cycle = await client.query<{ status: string }>("SELECT status FROM inquiry_cycles WHERE id = $1 AND session_id = $2 FOR UPDATE", [saved.cycle_id, saved.session_id]);
  const current = (await client.query<RequestRow>("SELECT * FROM material_requests WHERE id = $1 FOR UPDATE", [saved.id])).rows[0];
  if (!current || current.session_id !== saved.session_id || current.cycle_id !== saved.cycle_id || current.sync_operation_id !== saved.sync_operation_id) throw conflict();
  // A duplicate response may acknowledge the same already-recorded operation
  // after closure, but cannot mutate a completed cycle or a newer operation.
  if (current.sync_status !== "synced" && cycle.rows[0]?.status !== "active") throw new UserFacingError("탐구 회차가 변경되었습니다. 원래 준비물 전송 기록을 확인해 주세요.");
  return current;
}

async function sendSavedMaterials(saved: RequestRow, actorId: string) {
  const db = await getDb();
  const snapshot = parse(saved.sync_snapshot!);
  const operationId = saved.sync_operation_id!;
  // No expiring lease: uncertain operations are retried with their exact batch.
  const owner = (await db.query<{ operation_id: string }>("SELECT operation_id FROM material_sheet_dispatch WHERE spreadsheet_id = $1", [snapshot.spreadsheetId])).rows[0];
  if (owner?.operation_id !== operationId) {
    const latest = (await db.query<RequestRow>("SELECT * FROM material_requests WHERE id = $1", [saved.id])).rows[0];
    if (latest?.sync_operation_id === operationId && latest.sync_status === "synced") return result(latest, "synced");
    throw conflict();
  }
  try {
    let batch = saved.sync_batch ? parse(saved.sync_batch) : null;
    if (!batch) {
      const prepared = await prepareMaterialSheetTransfer(snapshot, operationId);
      await db.query(`UPDATE material_requests SET sync_batch = $1 WHERE id = $2 AND sync_operation_id = $3 AND sync_batch IS NULL`, [JSON.stringify(prepared), saved.id, operationId]);
      const latest = (await db.query<RequestRow>("SELECT * FROM material_requests WHERE id = $1", [saved.id])).rows[0];
      if (latest.sync_operation_id !== operationId || !latest.sync_batch) throw conflict();
      batch = parse(latest.sync_batch);
    }
    await executeMaterialSheetTransfer(snapshot.spreadsheetId, batch);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const current = await lockMaterialResult(client, saved);
      if (current.sync_status === "synced") {
        await client.query("COMMIT");
        return result(current, "synced");
      }
      await client.query(`UPDATE material_requests SET sync_status = 'synced', sync_error = NULL, synced_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND sync_operation_id = $2 AND sync_status <> 'synced'`, [saved.id, operationId]);
      await client.query("DELETE FROM material_sheet_dispatch WHERE spreadsheet_id = $1 AND operation_id = $2", [snapshot.spreadsheetId, operationId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } catch (error) {
    const message = userFacingMessage(error, "Google Sheets 전송에 실패했습니다. 담당 교사가 연결 상태를 확인해 주세요.");
    const pending = message.includes("연결 대기 중");
    const client = await db.connect();
    let changed: RequestRow;
    try {
      await client.query("BEGIN");
      const current = await lockMaterialResult(client, saved);
      if (current.sync_status === "synced") {
        await client.query("COMMIT");
        return result(current, "synced");
      }
      const update = await client.query<RequestRow>(`UPDATE material_requests SET sync_status = $1, sync_error = $2
        WHERE id = $3 AND sync_operation_id = $4 AND sync_status <> 'synced' RETURNING *`, [pending ? "pending" : "failed", message, saved.id, operationId]);
      if (!update.rows[0]) throw conflict();
      changed = update.rows[0];
      await client.query("COMMIT");
    } catch (failure) { await client.query("ROLLBACK"); throw failure; }
    finally { client.release(); }
    await audit(actorId, "materials_saved", "material_request", saved.id, { syncStatus: pending ? "pending" : "failed" });
    return result(changed, pending ? "pending" : "failed", message);
  }
  await audit(actorId, "materials_synced", "material_request", saved.id, { operationId });
  return result(saved, "synced");
}

export async function retryMaterialSync(requestId: string, actorId: string) {
  const db = await getDb();
  const request = (await db.query<RequestRow>("SELECT * FROM material_requests WHERE id = $1", [requestId])).rows[0];
  if (!request) throw new UserFacingError("준비물 신청을 찾을 수 없습니다.");
  const submitter = (await db.query<{ account_type: string }>("SELECT account_type FROM users WHERE id = $1", [request.submitted_by])).rows[0];
  if (submitter?.account_type === "demo") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [request.session_id]);
      await lockMaterialActor(client, actorId, request.team_id);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return result(request, "pending", demoMessage);
  }
  return saveAndSyncMaterials({ submissionId: request.submission_id, sessionId: request.session_id, cycleId: request.cycle_id ?? undefined, teamId: request.team_id, actorId, items: parse(request.form_data) }, true);
}
