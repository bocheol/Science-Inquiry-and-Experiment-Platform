import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { createClub, createClubTeam, enrollClubStudent, assignClubStudent, leaveClub, getStudentActivities } from '@/lib/clubs';
import { assignStudent, archiveTeam, restoreTeam } from '@/lib/teams';
import { getInquiryDataForUser } from '@/lib/inquiry-data';
import { assertDiscussionAccess, checkActivityDate, confirmMeeting, getDiscussionData, saveDiscussionEntry, seoulDate, type DiscussionActor } from '@/lib/discussions';
import { prepareSummaryInput, runDailySummaries, summarizeDiscussionDay, validateSummaryItems, type SummaryGenerator } from '@/lib/discussion-summary';
import { getTeacherDashboardData } from '@/lib/teacher-data';

const teacher: DiscussionActor = { id: 'teacher_bootstrap', role: 'teacher', mustChangePassword: false };
const student: DiscussionActor = { id: 'demo_student_1', role: 'student', mustChangePassword: false };
const peer: DiscussionActor = { id: 'demo_student_2', role: 'student', mustChangePassword: false };
let clubId: string, clubTeam: string, clubSession: string;
const date = '2026-08-20';
const generator: SummaryGenerator = async input => {
  const { records } = JSON.parse(input);
  return { items: records.map((r: { id: string }) => ({ category: 'discussion', text: '대면 메모에 따르면 온도를 통제하기로 논의했다.', sourceIds: [r.id] })) };
};

beforeAll(async () => {
  clubId = await createClub(teacher.id, '익명 과학 동아리');
  clubTeam = await createClubTeam(teacher.id, clubId, '온도 탐구팀');
  await enrollClubStudent(teacher.id, clubId, '10901', '');
  await assignClubStudent(teacher.id, clubId, student.id, clubTeam, true);
  const db = await getDb();
  clubSession = (await db.query('SELECT id FROM inquiry_sessions WHERE team_id = $1', [clubTeam])).rows[0].id;
});

describe('class and club separation', () => {
  it('keeps both memberships and existing password when classroom assignment is repeated', async () => {
    const db = await getDb();
    const before = (await db.query('SELECT password_hash FROM users WHERE id = $1', [student.id])).rows[0].password_hash;
    const result = await enrollClubStudent(teacher.id, clubId, '10901', '');
    expect(result.temporaryPassword).toBeNull();
    await assignStudent(teacher.id, student.id, 'demo_team_1');
    expect((await getStudentActivities(student.id)).map(t => t.id)).toEqual(expect.arrayContaining(['demo_team_1', clubTeam]));
    expect((await getInquiryDataForUser(student.id, clubTeam))?.team.clubId).toBe(clubId);
    expect((await getInquiryDataForUser(student.id, 'demo_team_1'))?.team.clubId).toBeNull();
    expect((await getTeacherDashboardData()).students.filter(s => s.id === student.id)).toHaveLength(1);
    expect((await db.query('SELECT password_hash FROM users WHERE id = $1', [student.id])).rows[0].password_hash).toBe(before);
  });
  it('creates second-year accounts with a mandatory password change and rejects cross-club assignment', async () => {
    const created = await enrollClubStudent(teacher.id, clubId, '20101', '익명학생');
    expect(created.temporaryPassword).toBeTruthy();
    await assignClubStudent(teacher.id, clubId, created.studentId, clubTeam);
    await expect(assertDiscussionAccess({ ...student, id: created.studentId }, clubSession)).rejects.toMatchObject({ status: 403 });
    const another = await createClub(teacher.id, '다른 동아리');
    await expect(assignClubStudent(teacher.id, another, student.id, clubTeam)).rejects.toThrow();
  });
});

describe('immutable discussion records and summaries', () => {
  it('validates access, real dates and participants', async () => {
    expect(seoulDate('2026-08-20T15:00:00Z')).toBe('2026-08-21');
    expect(() => checkActivityDate('2026-02-30')).toThrow();
    await expect(assertDiscussionAccess(peer, clubSession)).rejects.toMatchObject({ status: 403 });
    await expect(saveDiscussionEntry(student, { id: 'invalid_meeting', sessionId: clubSession, kind: 'meeting', date, content: '메모', participantIds: [peer.id] })).rejects.toThrow();
    await expect(saveDiscussionEntry(teacher, { id: 'teacher_message', sessionId: clubSession, kind: 'peer', content: '대신 작성' })).rejects.toMatchObject({ status: 403 });
  });
  it('saves once on retries, keeps supplements separate, and checks only listed participants', async () => {
    const payload = { id: 'meeting_original', sessionId: clubSession, kind: 'meeting' as const, date, content: '온도를 통제하고 시간을 측정하자.', participantIds: [student.id] };
    await saveDiscussionEntry(student, payload); await saveDiscussionEntry(student, payload);
    await expect(saveDiscussionEntry(student, { ...payload, content: '덮어쓰기' })).rejects.toMatchObject({ status: 409 });
    await saveDiscussionEntry(student, { id: 'meeting_supplement', sessionId: clubSession, kind: 'supplement', date, parentId: payload.id, content: '측정 간격은 아직 결정하지 못했다.' });
    await confirmMeeting(student, clubSession, payload.id);
    const data = await getDiscussionData(teacher, clubSession, date);
    expect(data.sources).toHaveLength(2);
    expect(data.sources.find(s => s.id === payload.id)?.content).toBe(payload.content);
    expect(data.sources.find(s => s.id === payload.id)?.confirmedBy).toEqual([student.id]);
    await expect(confirmMeeting(peer, clubSession, payload.id)).rejects.toMatchObject({ status: 403 });
  });
  it('redacts names and ids, validates references and keeps AI suggestions distinct', async () => {
    const data = await getDiscussionData(teacher, clubSession, date);
    const source = { ...data.sources[0], content: '김하늘 10901 이새봄 10902 example@test.com 010-1234-5678' };
    const prepared = await prepareSummaryInput([source]);
    expect(JSON.stringify(prepared.records)).not.toMatch(/김하늘|이새봄|10901|10902|example@test|010-1234/);
    expect(() => validateSummaryItems([{ category: 'decision', text: '결정', sourceIds: ['missing'] }], [source])).toThrow();
    expect(() => validateSummaryItems([{ category: 'decision', text: '결정', sourceIds: [source.id] }], [{ ...source, kind: 'ai_answer' }])).toThrow();
  });
  it('generates once, preserves evidence snapshots and versions when new records arrive during generation', async () => {
    expect(await summarizeDiscussionDay(clubSession, date, generator)).toBe(true);
    expect(await summarizeDiscussionDay(clubSession, date, generator)).toBe(false);
    await saveDiscussionEntry(student, { id: 'late_supplement_1', sessionId: clubSession, kind: 'supplement', date, parentId: 'meeting_original', content: '세 번 반복하자는 제안' });
    expect(await summarizeDiscussionDay(clubSession, date, async input => {
      await saveDiscussionEntry(student, { id: 'late_supplement_2', sessionId: clubSession, kind: 'supplement', date, parentId: 'meeting_original', content: '역할은 다음 시간에 결정하자.' });
      expect(await summarizeDiscussionDay(clubSession, date, generator)).toBe(false);
      return generator(input);
    })).toBe(true);
    const pending = await getDiscussionData(teacher, clubSession, date);
    expect(pending.jobs[0].requested_version).toBeGreaterThan(pending.jobs[0].generated_version);
    expect((await runDailySummaries(2, generator)).completed).toBe(1);
    const ready = await getDiscussionData(teacher, clubSession, date);
    expect(ready.history).toHaveLength(1);
    expect(ready.history[0].sources).toHaveLength(4);
    const db = await getDb();
    expect((await db.query('SELECT id FROM discussion_summaries WHERE session_id = $1', [clubSession])).rows).toHaveLength(3);
  });
  it('retries failed meetings today but leaves today remote chat for the next day', async () => {
    await saveDiscussionEntry(student, { id: 'remote_today', sessionId: 'demo_session_1', kind: 'peer', content: '내일 질문을 정리하자.' });
    await saveDiscussionEntry(student, { id: 'meeting_today', sessionId: clubSession, kind: 'meeting', date: seoulDate(), content: '세 번 측정했다는 대면 메모', participantIds: [student.id] });
    expect(await summarizeDiscussionDay(clubSession, seoulDate(), async () => { throw new Error('unavailable'); })).toBe(false);
    const db = await getDb();
    await db.query('UPDATE discussion_days SET retry_after = NULL WHERE session_id = $1', [clubSession]);
    const result = await runDailySummaries(10, generator);
    expect(result).toEqual({ attempted: 1, completed: 1 });
    const data = await getDiscussionData(teacher, 'demo_session_1', seoulDate());
    expect(data.sources).toHaveLength(1); expect(data.history).toHaveLength(0);
  });
  it('preserves records after archive and club departure, leaving classroom membership intact', async () => {
    await archiveTeam(teacher.id, clubTeam, '익명 과학 동아리 온도 탐구팀');
    await expect(assertDiscussionAccess(student, clubSession)).rejects.toMatchObject({ status: 403 });
    expect((await getDiscussionData(teacher, clubSession, date)).sources).toHaveLength(4);
    await restoreTeam(teacher.id, clubTeam);
    await leaveClub(teacher.id, clubId, student.id);
    expect((await getStudentActivities(student.id)).map(t => t.id)).toEqual(['demo_team_1']);
    await expect(assertDiscussionAccess(student, clubSession)).rejects.toMatchObject({ status: 403 });
    expect((await getDiscussionData(teacher, clubSession, date)).sources).toHaveLength(4);
  });
});
