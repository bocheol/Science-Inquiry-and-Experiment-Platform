// Run only inside the existing server credential context after operator review.
// GET-only metadata probes. No student rows, sheet cell values, uploads, shares,
// credential creation, or paid AI calls. K_SERVICE is not connection evidence.
import { pathToFileURL } from 'node:url';

export async function probeGoogle(targets, getHeaders, transport = fetch) {
  let headers;
  try { headers = await getHeaders(); }
  catch { return { authentication: 'failed_or_unavailable', targets: [], writesPerformed: false }; }
  const get = async (url) => {
    const response = await transport(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: response.status, data: null };
    return { status: response.status, data: await response.json() };
  };
  const results = [];
  for (const [index, target] of targets.entries()) {
    const result = { targetIndex: index, spreadsheetRead: false, spreadsheetEditCapability: null, folderAddCapability: null };
    try {
      if (target.spreadsheetId) {
        if (!/^[A-Za-z0-9_-]+$/.test(target.spreadsheetId)) throw Error('Invalid configured ID');
        const sheet = await get('https://sheets.googleapis.com/v4/spreadsheets/' + target.spreadsheetId + '?fields=spreadsheetId');
        result.spreadsheetRead = sheet.status === 200 && sheet.data?.spreadsheetId === target.spreadsheetId;
        const metadata = await get('https://www.googleapis.com/drive/v3/files/' + target.spreadsheetId + '?fields=mimeType,capabilities(canEdit)&supportsAllDrives=true');
        result.spreadsheetEditCapability = metadata.status === 200 ? metadata.data?.capabilities?.canEdit === true : null;
      }
      if (target.folderId) {
        if (!/^[A-Za-z0-9_-]+$/.test(target.folderId)) throw Error('Invalid configured ID');
        const metadata = await get('https://www.googleapis.com/drive/v3/files/' + target.folderId + '?fields=mimeType,capabilities(canAddChildren)&supportsAllDrives=true');
        result.folderAddCapability = metadata.status === 200
          ? metadata.data?.mimeType === 'application/vnd.google-apps.folder' && metadata.data?.capabilities?.canAddChildren === true : null;
      }
    } catch { result.error = 'metadata_probe_failed'; }
    results.push(result);
  }
  return { authentication: 'headers_obtained_not_sufficient_alone', targets: results, writesPerformed: false,
    limitation: 'Metadata access and reported capabilities only; uploads, quota, real sharing and writes are not verified.' };
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.INSTANCE_UNIX_SOCKET) throw Error('Existing server database context is unavailable; no connection was attempted.');
  const { Pool } = await import('pg');
  const { GoogleAuth, OAuth2Client } = await import('google-auth-library');
  const pool = new Pool(process.env.INSTANCE_UNIX_SOCKET
    ? { host: process.env.INSTANCE_UNIX_SOCKET, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 1, connectionTimeoutMillis: 5000 }
    : { connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await client.query(`SELECT u.login_id,s.spreadsheet_id,s.folder_id
      FROM users u JOIN record_teacher_classes a ON a.teacher_id=u.id
      JOIN class_journal_teacher_assignments j ON j.class_id=a.class_id AND j.teacher_id=u.id
      LEFT JOIN record_teacher_settings s ON s.teacher_id=u.id
      WHERE u.role='teacher' AND u.status='active' AND u.academic_year=$1
      GROUP BY u.login_id,s.spreadsheet_id,s.folder_id ORDER BY u.login_id`, [2026]);
    await client.query('COMMIT');
    const yearMatches = process.env.RECORDS_DESTINATION_YEAR === '2026';
    const targets = rows.map(row => ({
      spreadsheetId: row.spreadsheet_id || (yearMatches && /^teacher[1-4]$/.test(row.login_id) ? process.env['RECORDS_SPREADSHEET_' + row.login_id.toUpperCase() + '_ID'] : '') || '',
      folderId: row.folder_id || (yearMatches ? process.env.RECORDS_DRIVE_FOLDER_ID : '') || '',
    }));
    const getHeaders = async () => {
      if (process.env.RECORDS_GOOGLE_REFRESH_TOKEN) {
        const auth = new OAuth2Client(process.env.RECORDS_GOOGLE_CLIENT_ID, process.env.RECORDS_GOOGLE_CLIENT_SECRET);
        auth.setCredentials({ refresh_token: process.env.RECORDS_GOOGLE_REFRESH_TOKEN });
        return auth.getRequestHeaders();
      }
      const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
      const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets'], ...(credentials ? { credentials } : {}) });
      return (await auth.getClient()).getRequestHeaders();
    };
    console.log(JSON.stringify(await probeGoogle(targets, getHeaders), null, 2));
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Read-only server connection probe unavailable or failed. Details suppressed; no writes were requested.'); process.exitCode = 1; });
}
