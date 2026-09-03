import { OAuth2Client } from 'google-auth-library';
import { runDailySummaries } from '@/lib/discussion-summary';

const verifier = new OAuth2Client();
export async function POST(request: Request) {
  const audience = process.env.SUMMARY_SCHEDULER_AUDIENCE;
  const email = process.env.SUMMARY_SCHEDULER_EMAIL;
  const authorization = request.headers.get('authorization') ?? '';
  if (!audience || !email || !authorization.startsWith('Bearer ')) return Response.json({ message: '권한이 없습니다.' }, { status: 403 });
  try {
    const ticket = await verifier.verifyIdToken({ idToken: authorization.slice(7), audience });
    const payload = ticket.getPayload();
    if (payload?.email !== email || payload.email_verified !== true) return Response.json({ message: '권한이 없습니다.' }, { status: 403 });
  } catch { return Response.json({ message: '권한이 없습니다.' }, { status: 403 }); }
  try {
    const result = await runDailySummaries();
    console.info(JSON.stringify({ event: 'daily_summary_batch', ...result }));
    return Response.json(result);
  } catch {
    console.warn(JSON.stringify({ event: 'daily_summary_batch_failed' }));
    return Response.json({ message: '처리를 다시 시도해 주세요.' }, { status: 503 });
  }
}
