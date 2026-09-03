import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), run: vi.fn() }));
vi.mock('google-auth-library', () => ({ OAuth2Client: class { verifyIdToken = mocks.verify; } }));
vi.mock('@/lib/discussion-summary', () => ({ runDailySummaries: mocks.run }));
import { POST } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('denies missing configuration and missing authentication without running summaries', async () => {
  vi.stubEnv('SUMMARY_SCHEDULER_AUDIENCE', '');
  expect((await POST(new Request('https://example.test'))).status).toBe(403);
  expect(mocks.run).not.toHaveBeenCalled();
});
it('requires a verified token for the exact scheduler service account', async () => {
  vi.stubEnv('SUMMARY_SCHEDULER_AUDIENCE', 'https://example.test');
  vi.stubEnv('SUMMARY_SCHEDULER_EMAIL', 'scheduler@example.test');
  const request = () => new Request('https://example.test', { headers: { authorization: 'Bearer synthetic-token' } });
  mocks.verify.mockRejectedValueOnce(new Error('invalid signature'));
  expect((await POST(request())).status).toBe(403);
  mocks.verify.mockResolvedValueOnce({ getPayload: () => ({ email: 'other@example.test', email_verified: true }) });
  expect((await POST(request())).status).toBe(403);
  mocks.verify.mockResolvedValueOnce({ getPayload: () => ({ email: 'scheduler@example.test', email_verified: false }) });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.verify.mockResolvedValueOnce({ getPayload: () => ({ email: 'scheduler@example.test', email_verified: true }) });
  mocks.run.mockResolvedValueOnce({ attempted: 0, completed: 0 });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.verify).toHaveBeenLastCalledWith({ idToken: 'synthetic-token', audience: 'https://example.test' });
  expect(mocks.run).toHaveBeenCalledOnce();
});
