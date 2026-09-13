import { beforeAll, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), generations: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.actor }));
vi.mock("@/lib/discussion-summary", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/discussion-summary")>();
  return { ...original, summarizeDiscussionDay: (session: string, date: string, _generator: unknown, cycle: string) => original.summarizeDiscussionDay(session, date, async input => {
    mocks.generations();
    return { items: JSON.parse(input).records.map((record: { id: string }) => ({ category: "discussion", text: "합성 기록 정리", sourceIds: [record.id] })) };
  }, cycle) };
});
import { getDb } from "@/lib/db";
import { createClub, createClubTeam, enrollClubStudent, assignClubStudent, leaveClub } from "@/lib/clubs";
import { createClubConfigDraft } from "@/lib/club-settings";
import { getDiscussionData, saveDiscussionEntry, seoulDate } from "@/lib/discussions";
import { GET, POST } from "@/app/api/discussions/route";

const student = { id: "demo_student_1", role: "student" as const, mustChangePassword: false };
const teacher = (id: string) => ({ id, role: "teacher" as const, mustChangePassword: false });
let club: string, session: string, cycle: string;
const date = seoulDate();
beforeAll(async () => {
  const db = await getDb();
  for (const id of ["assigned", "shared", "master", "disabled", "password"]) await db.query(
    "INSERT INTO users(id,name,login_id,academic_year,role,password_hash,is_master,status,must_change_password) VALUES($1,'합성 교사',$1,2026,'teacher','unused',$2,$3,$4)",
    [`discussion_${id}`, id === "master", id === "disabled" ? "inactive" : "active", id === "password"],
  );
  club = await createClub("discussion_assigned", "합성 공동조회 동아리");
  const team = await createClubTeam("discussion_assigned", club, "합성 팀");
  await enrollClubStudent("discussion_assigned", club, "10901", "");
  await assignClubStudent("discussion_assigned", club, student.id, team);
  session = (await db.query("SELECT id FROM inquiry_sessions WHERE team_id=$1", [team])).rows[0].id;
  cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id=$1", [session])).rows[0].id;
  await saveDiscussionEntry(student, { id: "shared_access_original", sessionId: session, cycleId: cycle, kind: "peer", content: "공동조회 원문 보존" });
});
const read = () => GET(new Request(`http://localhost/api/discussions?sessionId=${session}&cycleId=${cycle}&date=${date}`));
const summarize = () => POST(new Request("http://localhost/api/discussions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "summarize", sessionId: session, cycleId: cycle, date }) }));

it.each(["assigned", "shared", "master"])("allows %s teachers to jointly read and summarize student records", async kind => {
  mocks.actor.mockResolvedValue(teacher(`discussion_${kind}`));
  await saveDiscussionEntry(student, { id: `shared_access_${kind}`, sessionId: session, cycleId: cycle, kind: "peer", content: `합성 ${kind} 조회 전 기록` });
  const response = await read();
  expect(response.status).toBe(200);
  expect((await response.json()).sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: "shared_access_original" })]));
  expect((await (await summarize()).json()).summarized).toBe(true);
});

it("restricts operating settings to assigned teachers and masters despite shared record access", async () => {
  await expect(createClubConfigDraft("discussion_shared", { clubId: club, configType: "report" })).rejects.toThrow(/권한/);
  await expect(createClubConfigDraft("discussion_assigned", { clubId: club, configType: "report" })).resolves.toBeTruthy();
  await expect(createClubConfigDraft("discussion_master", { clubId: club, configType: "report" })).resolves.toBeTruthy();
});

it.each(["disabled", "password"])("rejects %s teachers before reading or starting a generation", async kind => {
  mocks.actor.mockResolvedValue(teacher(`discussion_${kind}`));
  const calls = mocks.generations.mock.calls.length;
  expect((await read()).status).toBe(403);
  expect((await summarize()).status).toBe(403);
  expect(mocks.generations).toHaveBeenCalledTimes(calls);
});

it("keeps students scoped to their team and preserves former-member history for teachers", async () => {
  mocks.actor.mockResolvedValue({ ...student, id: "demo_student_2" });
  expect((await read()).status).toBe(403);
  mocks.actor.mockResolvedValue(student);
  expect((await read()).status).toBe(200);
  expect((await summarize()).status).toBe(403);
  const before = await getDiscussionData(teacher("discussion_shared"), session, date, cycle);
  await leaveClub("discussion_assigned", club, student.id);
  expect((await read()).status).toBe(403);
  const after = await getDiscussionData(teacher("discussion_shared"), session, date, cycle);
  expect(after.sources).toEqual(before.sources);
  expect(after.history).toEqual(before.history);
});
