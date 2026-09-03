import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

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

export async function markDiscussionDay(sessionId: string, date: string, client?: Pick<PoolClient, "query">) {
  const db = client ?? await getDb();
  await db.query(`INSERT INTO discussion_days (session_id, activity_date) VALUES ($1, $2)
    ON CONFLICT (session_id, activity_date) DO UPDATE SET requested_version = discussion_days.requested_version + 1, status = 'pending', retry_after = NULL`, [sessionId, date]);
}

export async function saveDiscussionEntry(actor: DiscussionActor, input: { id: string; sessionId: string; kind: "peer" | "meeting" | "supplement"; date?: string; content: string; participantIds?: string[]; parentId?: string }) {
  const teamId = await assertDiscussionAccess(actor, input.sessionId, true);
  if (actor.role !== "student") throw new DiscussionError("학생 기록은 학생 본인이 작성합니다.", 403);
  const content = input.content.trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.id) || !content || content.length > (input.kind === "peer" ? 4000 : 16000)) throw new DiscussionError("내용의 길이와 저장 요청을 확인해 주세요.");
  const db = await getDb(); const client = await db.connect();
  let date = input.kind === "peer" ? seoulDate() : checkActivityDate(input.date ?? "");
  try {
    await client.query("BEGIN");
    // Serialize with team assignment/deactivation and make client retries idempotent.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [actor.id]);
    await assertDiscussionAccess(actor, input.sessionId, true, client);
    const previous = await client.query<{ session_id: string; author_id: string; activity_date: string; content: string; kind: string; parent_id: string | null; participants: DiscussionEntry['participants'] }>("SELECT session_id, author_id, activity_date, content, kind, parent_id, participants FROM discussion_entries WHERE id = $1", [input.id]);
    if (previous.rows[0]) {
      const p = previous.rows[0];
      if (p.session_id !== input.sessionId || p.author_id !== actor.id || p.content !== content || p.kind !== input.kind) throw new DiscussionError("저장 요청이 다른 기록과 겹칩니다.", 409);
      if (input.kind === 'meeting' && (p.activity_date !== date || JSON.stringify(jsonValue(p.participants).map(m => m.id).sort()) !== JSON.stringify([...new Set(input.participantIds ?? [])].sort()))) throw new DiscussionError('날짜 또는 참여자가 다른 저장 요청입니다.', 409);
      if (input.kind === 'supplement' && p.parent_id !== input.parentId) throw new DiscussionError('보완 대상이 다른 저장 요청입니다.', 409);
      await client.query("COMMIT"); return { id: input.id, date: p.activity_date };
    }
    let participants: Array<{ id: string; name: string }> = [];
    if (input.kind === "supplement") {
      const parent = await client.query<{ activity_date: string; participants: typeof participants }>("SELECT activity_date, participants FROM discussion_entries WHERE id = $1 AND session_id = $2 AND kind = 'meeting'", [input.parentId, input.sessionId]);
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
    await client.query("INSERT INTO discussion_entries (id, session_id, author_id, kind, activity_date, content, participants, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [input.id, input.sessionId, actor.id, input.kind, date, content, JSON.stringify(participants), input.kind === "supplement" ? input.parentId : null]);
    await markDiscussionDay(input.sessionId, date, client);
    if (input.kind !== 'peer') await client.query("UPDATE discussion_days SET immediate_requested = TRUE WHERE session_id = $1 AND activity_date = $2", [input.sessionId, date]);
    await client.query("UPDATE inquiry_sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1", [input.sessionId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actor.id, "discussion_saved", "discussion_entry", input.id, { kind: input.kind });
  return { id: input.id, date };
}

export async function confirmMeeting(actor: DiscussionActor, sessionId: string, entryId: string) {
  await assertDiscussionAccess(actor, sessionId);
  const db = await getDb();
  const entry = await db.query<{ participants: Array<{ id: string; name: string }>; activity_date: string }>("SELECT participants, activity_date FROM discussion_entries WHERE id = $1 AND session_id = $2 AND kind = 'meeting'", [entryId, sessionId]);
  if (!entry.rows[0] || actor.role !== "student" || !jsonValue(entry.rows[0].participants).some(p => p.id === actor.id)) throw new DiscussionError("이 대면 기록의 참여자만 확인할 수 있습니다.", 403);
  await db.query("INSERT INTO discussion_confirmations (entry_id, user_id) VALUES ($1, $2) ON CONFLICT (entry_id, user_id) DO NOTHING", [entryId, actor.id]);
  await audit(actor.id, "meeting_confirmed", "discussion_entry", entryId);
}

export async function readDiscussionSources(sessionId: string, date: string): Promise<DiscussionEntry[]> {
  checkActivityDate(date);
  const db = await getDb();
  const start = new Date(`${date}T00:00:00+09:00`); const end = new Date(start.getTime() + 86_400_000);
  const ai = await db.query<{ id: string; sender_id: string | null; name: string | null; role: string; content: string; created_at: Date }>("SELECT m.id, m.sender_id, u.name, m.role, m.content, m.created_at FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.session_id = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.role IN ('user','assistant') ORDER BY m.created_at, m.sequence", [sessionId, start, end]);
  const entries = await db.query<{ id: string; author_id: string; name: string; kind: "peer" | "meeting" | "supplement"; content: string; participants: DiscussionEntry["participants"]; parent_id: string | null; created_at: Date }>("SELECT e.id, e.author_id, u.name, e.kind, e.content, e.participants, e.parent_id, e.created_at FROM discussion_entries e JOIN users u ON u.id = e.author_id WHERE e.session_id = $1 AND e.activity_date = $2 ORDER BY e.created_at, e.id", [sessionId, date]);
  const confirmations = await db.query<{ entry_id: string; user_id: string }>("SELECT c.entry_id, c.user_id FROM discussion_confirmations c JOIN discussion_entries e ON e.id = c.entry_id WHERE e.session_id = $1 AND e.activity_date = $2", [sessionId, date]);
  return [
    ...ai.rows.map(m => ({ id: m.id, sessionId, authorId: m.sender_id, authorName: m.role === "assistant" ? "AI" : m.name ?? "이전 팀원", kind: m.role === "assistant" ? "ai_answer" as const : "ai_question" as const, activityDate: date, content: m.content, participants: [], parentId: null, createdAt: new Date(m.created_at).toISOString(), confirmedBy: [] })),
    ...entries.rows.map(e => ({ id: e.id, sessionId, authorId: e.author_id, authorName: e.name, kind: e.kind, activityDate: date, content: e.content, participants: jsonValue(e.participants), parentId: e.parent_id, createdAt: new Date(e.created_at).toISOString(), confirmedBy: confirmations.rows.filter(c => c.entry_id === e.id).map(c => c.user_id) })),
  ].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getDiscussionData(actor: DiscussionActor, sessionId: string, date: string) {
  await assertDiscussionAccess(actor, sessionId); checkActivityDate(date);
  const db = await getDb();
  const sources = await readDiscussionSources(sessionId, date);
  const summaries = await db.query<{ id: string; activity_date: string; version: number; content: SummaryItem[]; sources: DiscussionEntry[]; created_at: Date }>(`SELECT s.id, s.activity_date, s.version, s.content, CASE WHEN s.activity_date = $2 THEN s.sources ELSE '[]'::jsonb END AS sources, s.created_at
    FROM discussion_summaries s JOIN discussion_days d ON d.session_id = s.session_id AND d.activity_date = s.activity_date AND d.generated_version = s.version
    WHERE s.session_id = $1 ORDER BY s.activity_date DESC`, [sessionId, date]);
  const seen = new Set<string>();
  const history: DailySummary[] = [];
  for (const s of summaries.rows) {
    if (seen.has(s.activity_date)) continue;
    seen.add(s.activity_date);
    history.push({ id: s.id, activityDate: s.activity_date, version: s.version, createdAt: new Date(s.created_at).toISOString(), items: jsonValue(s.content), sources: jsonValue(s.sources) });
  }
  const jobs = await db.query<{ activity_date: string; requested_version: number; generated_version: number; status: string }>("SELECT activity_date, requested_version, generated_version, status FROM discussion_days WHERE session_id = $1 ORDER BY activity_date DESC", [sessionId]);
  return { sources, history, jobs: jobs.rows };
}
