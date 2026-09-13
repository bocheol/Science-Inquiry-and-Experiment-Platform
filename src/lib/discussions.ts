import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { enqueueDiscussionPush } from "@/lib/discussion-push";

export type DiscussionActor = Pick<SessionUser, "id" | "role" | "mustChangePassword">;
export class DiscussionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export type DiscussionEntry = {
  id: string; sessionId: string; authorId: string | null; authorName: string; kind: "peer" | "meeting" | "supplement" | "ai_question" | "ai_answer";
  activityDate: string; content: string; participants: Array<{ id: string; name: string }>;
  parentId: string | null; createdAt: string; confirmedBy: string[];
};
export type SummaryItem = { category: "discussion" | "decision" | "question" | "next" | "ai_suggestion" | "reported_activity"; text: string; sourceIds: string[] };
export type DailySummary = { id: string; activityDate: string; version: number; createdAt: string; items: SummaryItem[]; sources: DiscussionEntry[] };
export function seoulDate(value: Date | string = new Date()) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function checkActivityDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value > seoulDate() || value < "2020-01-01") throw new DiscussionError("실제 활동 날짜를 확인해 주세요. 미래 날짜는 기록할 수 없습니다.");
  return value;
}
export function jsonValue<T>(value: T | string): T { return typeof value === "string" ? JSON.parse(value) as T : value; }

export async function assertDiscussionAccess(actor: DiscussionActor, sessionId: string, write = false, client?: Pick<PoolClient, 'query'>) {
  if (actor.mustChangePassword) throw new DiscussionError("비밀번호를 변경한 뒤 이용해 주세요.", 403);
  const db = client ?? await getDb();
  const user = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1 AND status = 'active' AND must_change_password = FALSE", [actor.id]);
  if (!user.rows[0] || user.rows[0].role !== actor.role) throw new DiscussionError("권한이 없습니다.", 403);
  if (actor.role === "student") {
    const member = await db.query<{ id: string }>("SELECT t.id FROM teams t JOIN inquiry_sessions s ON s.team_id = t.id JOIN team_members tm ON tm.team_id = t.id WHERE s.id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND t.status = 'active'", [sessionId, actor.id]);
    if (!member.rows[0]) throw new DiscussionError("현재 팀 자료에 접근할 수 없습니다.", 403);
    return member.rows[0].id;
  }
  const team = await db.query<{ id: string; status: string }>("SELECT t.id, t.status FROM teams t JOIN inquiry_sessions s ON s.team_id = t.id WHERE s.id = $1", [sessionId]);
  if (!team.rows[0]) throw new DiscussionError("팀을 찾을 수 없습니다.", 404);
  if (write && team.rows[0].status !== "active") throw new DiscussionError("보관된 팀에는 새 기록을 남길 수 없습니다.", 403);
  return team.rows[0].id;
}

export async function markDiscussionDay(sessionId: string, date: string, client: Pick<PoolClient, "query">, cycleId: string) {
  const db = client ?? await getDb();
  await db.query(`INSERT INTO cycle_discussion_days (session_id, activity_date, cycle_id) VALUES ($1, $2, $3)
    ON CONFLICT (session_id, cycle_id, activity_date) DO UPDATE SET requested_version = cycle_discussion_days.requested_version + 1, status = 'pending', retry_after = NULL`, [sessionId, date, cycleId]);
}

export async function lockDiscussionCycle(client: PoolClient, sessionId: string, expectedCycleId?: string) {
  await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
  const cycle = await client.query<{ id: string }>(
    "SELECT id FROM inquiry_cycles WHERE session_id = $1 AND status = 'active' ORDER BY ordinal DESC LIMIT 1 FOR UPDATE", [sessionId],
  );
  const cycleId = cycle.rows[0]?.id;
  if (!cycleId || (expectedCycleId !== undefined && cycleId !== expectedCycleId)) {
    throw new DiscussionError("탐구 회차가 변경되었거나 완료되었습니다. 작성 내용을 보관하고 현재 회차를 확인해 주세요.", 409);
  }
  return cycleId;
}

export async function saveDiscussionEntry(actor: DiscussionActor, input: { id: string; sessionId: string; cycleId?: string; kind: "peer" | "meeting" | "supplement"; date?: string; content: string; participantIds?: string[]; parentId?: string }) {
  const teamId = await assertDiscussionAccess(actor, input.sessionId, true);
  if (actor.role !== "student") throw new DiscussionError("학생 기록은 학생 본인이 작성합니다.", 403);
  const content = input.content.trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.id) || !content || content.length > (input.kind === "peer" ? 4000 : 16000)) throw new DiscussionError("내용의 길이와 저장 요청을 확인해 주세요.");
  const db = await getDb(); const client = await db.connect();
  let date = input.kind === "peer" ? seoulDate() : checkActivityDate(input.date ?? "");
  try {
    await client.query("BEGIN");
    const cycleId = await lockDiscussionCycle(client, input.sessionId, input.cycleId);
    const recipientCandidates = input.kind === "peer" ? await client.query<{ user_id: string }>(
      "SELECT user_id FROM team_members WHERE team_id = $1 AND status = 'active'", [teamId],
    ) : { rows: [] };
    // Same session/student/team order as journal/evaluation writers.
    await lockStudentsTeams(client, [actor.id, ...recipientCandidates.rows.map(row => row.user_id), ...(input.kind === "meeting" ? input.participantIds ?? [] : [])], [teamId]);
    await assertDiscussionAccess(actor, input.sessionId, true, client);
    const previous = await client.query<{ session_id: string; cycle_id: string | null; author_id: string; activity_date: string; content: string; kind: string; parent_id: string | null; participants: DiscussionEntry['participants'] }>("SELECT session_id, cycle_id, author_id, activity_date, content, kind, parent_id, participants FROM discussion_entries WHERE id = $1", [input.id]);
    if (previous.rows[0]) {
      const p = previous.rows[0];
      if (p.session_id !== input.sessionId || p.cycle_id !== cycleId || p.author_id !== actor.id || p.content !== content || p.kind !== input.kind) throw new DiscussionError("저장 요청이 다른 기록과 겹칩니다.", 409);
      if (input.kind === 'meeting' && (p.activity_date !== date || JSON.stringify(jsonValue(p.participants).map(m => m.id).sort()) !== JSON.stringify([...new Set(input.participantIds ?? [])].sort()))) throw new DiscussionError('날짜 또는 참여자가 다른 저장 요청입니다.', 409);
      if (input.kind === 'supplement' && p.parent_id !== input.parentId) throw new DiscussionError('보완 대상이 다른 저장 요청입니다.', 409);
      await client.query("COMMIT"); return { id: input.id, date: p.activity_date };
    }
    let participants: Array<{ id: string; name: string }> = [];
    if (input.kind === "supplement") {
      const parent = await client.query<{ activity_date: string; participants: typeof participants }>("SELECT activity_date, participants FROM discussion_entries WHERE id = $1 AND session_id = $2 AND cycle_id = $3 AND kind = 'meeting'", [input.parentId, input.sessionId, cycleId]);
      if (!parent.rows[0]) throw new DiscussionError("보완할 대면 기록을 찾을 수 없습니다.");
      date = parent.rows[0].activity_date; participants = jsonValue(parent.rows[0].participants);
    } else if (input.kind === "meeting") {
      const ids = [...new Set(input.participantIds ?? [])];
      if (!ids.length || ids.length > 30) throw new DiscussionError("참여자를 선택해 주세요.");
      const members = await client.query<{ id: string; name: string }>("SELECT u.id, u.name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1 AND tm.status = 'active' AND u.status = 'active'", [teamId]);
      participants = members.rows.filter(m => ids.includes(m.id));
      if (participants.length !== ids.length || !ids.includes(actor.id)) throw new DiscussionError("기록자를 포함해 현재 팀의 참여자를 선택해 주세요.");
    }
    const recent = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM discussion_entries WHERE author_id = $1 AND created_at > $2", [actor.id, new Date(Date.now() - 60_000)]);
    if (Number(recent.rows[0].count) >= 30) throw new DiscussionError("메시지가 많습니다. 잠시 후 다시 보내 주세요.", 429);
    await client.query("INSERT INTO discussion_entries (id, session_id, cycle_id, author_id, kind, activity_date, content, participants, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [input.id, input.sessionId, cycleId, actor.id, input.kind, date, content, JSON.stringify(participants), input.kind === "supplement" ? input.parentId : null]);
    if (input.kind === "peer") {
      const recipients = await client.query<{ id: string; user_id: string }>(
        `SELECT tm.id, tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = $1 AND tm.status = 'active' AND u.status = 'active'
            AND u.role = 'student' AND u.academic_year = $2 AND tm.user_id <> $3`, [teamId, ACADEMIC_YEAR, actor.id],
      );
      const lockedIds = new Set(recipientCandidates.rows.map(row => row.user_id));
      if (recipients.rows.some(row => !lockedIds.has(row.user_id))) throw new DiscussionError("팀원이 변경되었습니다. 작성 내용을 유지하고 다시 보내 주세요.", 409);
      for (const recipient of recipients.rows) {
        await client.query("INSERT INTO discussion_message_recipients (entry_id, membership_id, user_id) VALUES ($1,$2,$3)", [input.id, recipient.id, recipient.user_id]);
      }
      await enqueueDiscussionPush(client, input.id);
    }
    await markDiscussionDay(input.sessionId, date, client, cycleId);
    if (input.kind !== 'peer') await client.query("UPDATE cycle_discussion_days SET immediate_requested = TRUE WHERE session_id = $1 AND activity_date = $2 AND cycle_id = $3", [input.sessionId, date, cycleId]);
    await client.query("UPDATE inquiry_sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1", [input.sessionId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actor.id, "discussion_saved", "discussion_entry", input.id, { kind: input.kind });
  return { id: input.id, date };
}

export async function confirmMeeting(actor: DiscussionActor, sessionId: string, entryId: string, expectedCycleId?: string) {
  const teamId = await assertDiscussionAccess(actor, sessionId, true);
  if (actor.role !== "student") throw new DiscussionError("이 대면 기록의 참여자만 확인할 수 있습니다.", 403);
  const db = await (await getDb()).connect();
  try {
  await db.query("BEGIN");
  const cycleId = await lockDiscussionCycle(db, sessionId, expectedCycleId);
  await lockStudentsTeams(db, [actor.id], [teamId]);
  await assertDiscussionAccess(actor, sessionId, true, db);
  const entry = await db.query<{ participants: Array<{ id: string; name: string }>; activity_date: string }>("SELECT participants, activity_date FROM discussion_entries WHERE id = $1 AND session_id = $2 AND cycle_id = $3 AND kind = 'meeting'", [entryId, sessionId, cycleId]);
  if (!entry.rows[0] || actor.role !== "student" || !jsonValue(entry.rows[0].participants).some(p => p.id === actor.id)) throw new DiscussionError("이 대면 기록의 참여자만 확인할 수 있습니다.", 403);
  await db.query("INSERT INTO discussion_confirmations (entry_id, user_id) VALUES ($1, $2) ON CONFLICT (entry_id, user_id) DO NOTHING", [entryId, actor.id]);
  await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  await audit(actor.id, "meeting_confirmed", "discussion_entry", entryId);
}

export async function discussionCycle(sessionId: string, cycleId?: string, client?: Pick<PoolClient, "query">) {
  const db = client ?? await getDb();
  const result = await db.query<{ id: string; title: string; status: string; ordinal: number }>(
    "SELECT id, title, status, ordinal FROM inquiry_cycles WHERE session_id = $1 AND ($2::text IS NULL OR id = $2) ORDER BY ordinal DESC LIMIT 1", [sessionId, cycleId ?? null],
  );
  if (!result.rows[0]) throw new DiscussionError("탐구 회차를 찾을 수 없습니다.", 404);
  return result.rows[0];
}

export async function readDiscussionSources(sessionId: string, date: string, expectedCycleId?: string, client?: Pick<PoolClient, "query">): Promise<DiscussionEntry[]> {
  checkActivityDate(date);
  const db = client ?? await getDb();
  const { id: cycleId } = await discussionCycle(sessionId, expectedCycleId, db);
  const start = new Date(`${date}T00:00:00+09:00`); const end = new Date(start.getTime() + 86_400_000);
  const ai = await db.query<{ id: string; sender_id: string | null; name: string | null; role: string; content: string; created_at: Date }>("SELECT m.id, m.sender_id, u.name, m.role, m.content, m.created_at FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.session_id = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.cycle_id = $4 AND m.role IN ('user','assistant') ORDER BY m.created_at, m.sequence", [sessionId, start, end, cycleId]);
  const entries = await db.query<{ id: string; author_id: string; name: string; kind: "peer" | "meeting" | "supplement"; content: string; participants: DiscussionEntry["participants"]; parent_id: string | null; created_at: Date }>("SELECT e.id, e.author_id, u.name, e.kind, e.content, e.participants, e.parent_id, e.created_at FROM discussion_entries e JOIN users u ON u.id = e.author_id WHERE e.session_id = $1 AND e.activity_date = $2 AND e.cycle_id = $3 ORDER BY e.created_at, e.id", [sessionId, date, cycleId]);
  const confirmations = await db.query<{ entry_id: string; user_id: string }>("SELECT c.entry_id, c.user_id FROM discussion_confirmations c JOIN discussion_entries e ON e.id = c.entry_id WHERE e.session_id = $1 AND e.activity_date = $2 AND e.cycle_id = $3", [sessionId, date, cycleId]);
  return [
    ...ai.rows.map(m => ({ id: m.id, sessionId, authorId: m.sender_id, authorName: m.role === "assistant" ? "AI" : m.name ?? "이전 팀원", kind: m.role === "assistant" ? "ai_answer" as const : "ai_question" as const, activityDate: date, content: m.content, participants: [], parentId: null, createdAt: new Date(m.created_at).toISOString(), confirmedBy: [] })),
    ...entries.rows.map(e => ({ id: e.id, sessionId, authorId: e.author_id, authorName: e.name, kind: e.kind, activityDate: date, content: e.content, participants: jsonValue(e.participants), parentId: e.parent_id, createdAt: new Date(e.created_at).toISOString(), confirmedBy: confirmations.rows.filter(c => c.entry_id === e.id).map(c => c.user_id) })),
  ].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function markDiscussionMessagesRead(actor: DiscussionActor, sessionId: string, cycleId: string, entryIds: string[]) {
  if (actor.role !== "student") throw new DiscussionError("학생 본인의 읽음만 기록할 수 있습니다.", 403);
  if (!entryIds.length || entryIds.length > 100 || entryIds.some(id => !/^[a-zA-Z0-9_-]{8,100}$/.test(id))) throw new DiscussionError("읽은 메시지를 확인해 주세요.");
  const teamId = await assertDiscussionAccess(actor, sessionId);
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    await discussionCycle(sessionId, cycleId, client);
    await lockStudentsTeams(client, [actor.id], [teamId]);
    await assertDiscussionAccess(actor, sessionId, false, client);
    const eligible = await client.query<{ entry_id: string }>(
      `SELECT r.entry_id FROM discussion_message_recipients r
        JOIN discussion_entries e ON e.id = r.entry_id
        JOIN team_members tm ON tm.id = r.membership_id AND tm.user_id = r.user_id
        JOIN users u ON u.id = r.user_id
        WHERE r.user_id = $1 AND e.session_id = $2 AND e.cycle_id = $3 AND e.kind = 'peer'
          AND tm.team_id = $4 AND tm.status = 'active' AND u.academic_year = $5 AND r.read_at IS NULL`,
      [actor.id, sessionId, cycleId, teamId, ACADEMIC_YEAR],
    );
    const requested = new Set(entryIds);
    const selected = eligible.rows.filter(row => requested.has(row.entry_id));
    for (const row of selected) await client.query("UPDATE discussion_message_recipients SET read_at = CURRENT_TIMESTAMP WHERE entry_id = $1 AND user_id = $2 AND read_at IS NULL", [row.entry_id, actor.id]);
    await client.query("COMMIT");
    return { marked: selected.length };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function getDiscussionData(actor: DiscussionActor, sessionId: string, date: string, expectedCycleId?: string) {
  await assertDiscussionAccess(actor, sessionId); checkActivityDate(date);
  const db = await getDb();
  const cycle = await discussionCycle(sessionId, expectedCycleId, db);
  const sources = await readDiscussionSources(sessionId, date, cycle.id, db);
  // Read receipts are delivery metadata, never included in AI source snapshots.
  // Only the author sees who read a message; each recipient sees their own eligibility.
  const receipts = actor.role === "student" ? await db.query<{ entry_id: string; user_id: string; name: string; read_at: Date | null }>(
    `SELECT r.entry_id, r.user_id, u.name, r.read_at FROM discussion_message_recipients r
      JOIN discussion_entries e ON e.id = r.entry_id JOIN users u ON u.id = r.user_id
      WHERE e.session_id = $1 AND e.cycle_id = $2 AND e.activity_date = $3 AND e.author_id = $4`,
    [sessionId, cycle.id, date, actor.id],
  ) : { rows: [] };
  const unread = actor.role === "student" ? await db.query<{ entry_id: string }>(
    `SELECT r.entry_id FROM discussion_message_recipients r JOIN discussion_entries e ON e.id = r.entry_id
      JOIN team_members tm ON tm.id = r.membership_id AND tm.user_id = r.user_id
      WHERE e.session_id = $1 AND e.cycle_id = $2 AND e.activity_date = $3
        AND r.user_id = $4 AND r.read_at IS NULL AND tm.status = 'active'`,
    [sessionId, cycle.id, date, actor.id],
  ) : { rows: [] };
  const summaries = await db.query<{ id: string; activity_date: string; version: number; content: SummaryItem[]; sources: DiscussionEntry[]; created_at: Date }>(`SELECT s.id, s.activity_date, s.version, s.content, CASE WHEN s.activity_date = $2 THEN s.sources ELSE '[]'::jsonb END AS sources, s.created_at
    FROM cycle_discussion_summaries s JOIN cycle_discussion_days d ON d.session_id = s.session_id AND d.cycle_id = s.cycle_id AND d.activity_date = s.activity_date AND d.generated_version = s.version
    WHERE s.session_id = $1 AND s.cycle_id = $3 ORDER BY s.activity_date DESC`, [sessionId, date, cycle.id]);
  const seen = new Set<string>();
  const history: DailySummary[] = [];
  for (const s of summaries.rows) {
    if (seen.has(s.activity_date)) continue;
    seen.add(s.activity_date);
    history.push({ id: s.id, activityDate: s.activity_date, version: s.version, createdAt: new Date(s.created_at).toISOString(), items: jsonValue(s.content), sources: jsonValue(s.sources) });
  }
  const jobs = await db.query<{ activity_date: string; requested_version: number; generated_version: number; status: string }>("SELECT activity_date, requested_version, generated_version, status FROM cycle_discussion_days WHERE session_id = $1 AND cycle_id = $2 ORDER BY activity_date DESC", [sessionId, cycle.id]);
  const legacy = await db.query<{ id: string; activity_date: string; version: number; content: SummaryItem[]; sources: DiscussionEntry[]; created_at: Date }>(
    "SELECT id, activity_date, version, content, sources, created_at FROM discussion_summaries WHERE session_id = $1 AND activity_date = $2 ORDER BY version DESC, id", [sessionId, date],
  );
  const cycles = await db.query<{ id: string; title: string; status: string; ordinal: number }>("SELECT id, title, status, ordinal FROM inquiry_cycles WHERE session_id = $1 ORDER BY ordinal", [sessionId]);
  return { sources, receipts: receipts.rows.map(row => ({ entryId: row.entry_id, userId: row.user_id, name: row.name, readAt: row.read_at ? new Date(row.read_at).toISOString() : null })), unreadEntryIds: unread.rows.map(row => row.entry_id), history, jobs: jobs.rows, cycle, cycles: cycles.rows, legacyHistory: legacy.rows.map(row => ({ id: row.id, activityDate: row.activity_date, version: row.version, items: jsonValue(row.content), sources: jsonValue(row.sources), createdAt: new Date(row.created_at).toISOString() })) };
}
