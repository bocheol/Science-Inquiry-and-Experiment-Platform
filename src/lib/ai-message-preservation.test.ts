import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({ default: class { responses = { create: mocks.create }; } }));
import { sendTeamMessage } from '@/lib/ai';
import { getDb } from '@/lib/db';
import { getDiscussionData, seoulDate } from '@/lib/discussions';
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => mocks.create.mockReset());
it('rejects a question from an old displayed cycle before saving or calling AI', async () => {
  const db = await getDb();
  await expect(sendTeamMessage('demo_session_1', 'demo_team_1', { id: 'demo_student_1', alias: '팀원 A' }, '오래된 화면 질문', undefined, 'old_cycle')).rejects.toThrow(/회차/);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await db.query("SELECT id FROM messages WHERE content = '오래된 화면 질문'")).rows).toHaveLength(0);
});

it('preserves saved questions on AI failure, marks their day, redacts input and keeps approved inquiry stage', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  mocks.create.mockRejectedValueOnce(new Error('synthetic unavailable'));
  await expect(sendTeamMessage('demo_session_1', 'demo_team_1', {id:'demo_student_1',alias:'팀원 A'}, '김하늘 10901 질문입니다.')).rejects.toThrow();
  const actor = {id:'teacher_bootstrap', role:'teacher' as const,mustChangePassword:false};
  const before = await getDiscussionData(actor, 'demo_session_1', seoulDate());
  expect(before.sources).toHaveLength(1); expect(before.jobs).toHaveLength(1);
  mocks.create.mockResolvedValueOnce({ output_text:'어떤 변인을 같게 할까요?',output:[],model:'synthetic' });
  await sendTeamMessage('demo_session_1', 'demo_team_1', {id:'demo_student_1',alias:'팀원 A'}, '이새봄 10902 측정 방법을 물었다.');
  expect(mocks.create.mock.calls[1][0].input).not.toMatch(/김하늘|10901|이새봄|10902/);
  const db = await getDb();
  expect((await db.query("SELECT stage FROM inquiry_sessions WHERE id = 'demo_session_1'")).rows[0].stage).toBe('EXPERIMENTING');
  expect((await getDiscussionData(actor, 'demo_session_1', seoulDate())).sources).toHaveLength(3);
});

it('reuses the same saved question and completed answer when a browser retries one request', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  const requestId = 'e629dc22-f6de-4e8f-8ea0-e260df15b915';
  const content = '같은 요청 재시도 검증 질문';
  mocks.create.mockRejectedValueOnce(new Error('synthetic interrupted'));
  await expect(sendTeamMessage('demo_session_1', 'demo_team_1', {id:'demo_student_1',alias:'팀원 A'}, content, requestId)).rejects.toThrow();
  mocks.create.mockResolvedValueOnce({ output_text:'재시도 뒤 저장된 답변', output:[], model:'synthetic' });
  await expect(sendTeamMessage('demo_session_1', 'demo_team_1', {id:'demo_student_1',alias:'팀원 A'}, content, requestId)).resolves.toMatchObject({ answer: '재시도 뒤 저장된 답변' });
  await expect(sendTeamMessage('demo_session_1', 'demo_team_1', {id:'demo_student_1',alias:'팀원 A'}, content, requestId)).resolves.toMatchObject({ answer: '재시도 뒤 저장된 답변' });
  expect(mocks.create).toHaveBeenCalledTimes(2);
  const db = await getDb();
  const messages = await db.query("SELECT role FROM messages WHERE session_id = 'demo_session_1' AND content IN ($1, $2) ORDER BY role", [content, '재시도 뒤 저장된 답변']);
  expect(messages.rows).toEqual([{ role: 'assistant' }, { role: 'user' }]);
});

it('preserves the question but rejects a late answer after the author leaves the team', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  const db = await getDb();
  mocks.create.mockImplementationOnce(async () => {
    await db.query("UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE user_id = 'demo_student_1' AND team_id = 'demo_team_1'");
    return { output_text: '소속 변경 뒤 늦은 답변', output: [] };
  });
  try {
    await expect(sendTeamMessage('demo_session_1', 'demo_team_1', { id: 'demo_student_1', alias: '팀원 A' }, '소속 변경 전 질문')).rejects.toThrow(/팀/);
    expect((await db.query("SELECT content FROM messages WHERE content IN ('소속 변경 전 질문', '소속 변경 뒤 늦은 답변')")).rows).toEqual([{ content: '소속 변경 전 질문' }]);
  } finally {
    await db.query("UPDATE team_members SET status = 'active', left_at = NULL WHERE user_id = 'demo_student_1' AND team_id = 'demo_team_1'");
  }
});
