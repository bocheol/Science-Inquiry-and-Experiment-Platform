import { GoogleAuth } from "google-auth-library";
import { UserFacingError } from "@/lib/user-facing-error";

export const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "1Ia5xoZZDv3b4sVq3la8POFNE_QVHEuLhitS-YC_QBVg";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";


function configuredCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new UserFacingError("Google Sheets 서비스 계정 설정을 확인해 주세요.");
  }
}

export function googleSheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.K_SERVICE ||
    process.env.GOOGLE_CLOUD_PROJECT,
  );
}

async function authorizedHeaders() {
  const credentials = configuredCredentials();
  const auth = new GoogleAuth({ scopes: [SHEETS_SCOPE], ...(credentials ? { credentials } : {}) });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function googleRequest<T>(spreadsheetId: string, path: string, init: RequestInit = {}) {
  const headers = await authorizedHeaders();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: { ...headers, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const result = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) {
    const googleMessage = result.error?.message ?? "";
    if (response.status === 403 && /has not been used|disabled/i.test(googleMessage)) {
      throw new UserFacingError("Google Cloud에서 Google Sheets API를 활성화해야 합니다.");
    }
    if (response.status === 403) {
      throw new UserFacingError("서비스 계정에 준비물 시트 편집 권한이 있는지 확인해 주세요.");
    }
    throw new UserFacingError("Google Sheets 요청에 실패했습니다. 연결 상태를 확인하고 다시 시도해 주세요.");
  }
  return result;
}

type SheetMetadata = { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };

export async function inspectGoogleSpreadsheet(spreadsheetId: string) {
  if (!googleSheetsConfigured()) throw new UserFacingError("Google Sheets 서비스 계정 연결 대기 중");
  const metadata = await googleRequest<SheetMetadata>(spreadsheetId, "?fields=properties.title,sheets.properties(sheetId,title)");
  return (metadata.sheets ?? []).flatMap((sheet) => sheet.properties?.title ? [{ id: sheet.properties.sheetId ?? 0, title: sheet.properties.title }] : []);
}

export async function readGoogleSheetHeaders(spreadsheetId: string, sheetName: string) {
  const range = encodeURIComponent(`${quoteSheet(sheetName)}!1:1`);
  const result = await googleRequest<{ values?: unknown[][] }>(spreadsheetId, `/values/${range}?majorDimension=ROWS`);
  return (result.values?.[0] ?? []).map((value) => String(value).trim()).filter(Boolean);
}

const MATERIAL_HEADER_ALIASES = new Set([
  "조", "팀", "학번", "팀장 학번", "조장", "팀장", "팀장 이름", "품명", "규격", "규격(선택옵션)",
  "단가", "개수", "갯수", "수량", "배송비", "합계", "총액", "링크",
]);

export async function detectGoogleMaterialSheetLayout(spreadsheetId: string, sheetName: string) {
  const range = encodeURIComponent(`${quoteSheet(sheetName)}!1:10`);
  const result = await googleRequest<{ values?: unknown[][] }>(spreadsheetId, `/values/${range}?majorDimension=ROWS`);
  const rows = result.values ?? [];
  let best = { headerRow: 1, headers: [] as string[], score: 0 };
  rows.forEach((row, index) => {
    const headers = row.map((value) => String(value ?? "").trim()).filter(Boolean);
    const score = headers.filter((header) => MATERIAL_HEADER_ALIASES.has(header)).length;
    if (score > best.score) best = { headerRow: index + 1, headers, score };
  });
  return { headerRow: best.headerRow, headers: best.headers, layout: best.score >= 4 && best.headerRow > 1 ? "team_sections" as const : "header_row" as const };
}

export async function ensureManagedMaterialHeaders(spreadsheetId: string, sheetName: string) {
  const existing = await readGoogleSheetHeaders(spreadsheetId, sheetName);
  if (existing.length) return existing;
  const headers = ["제출 시각", "팀 이름", "팀장 학번", "팀장 이름", "품명", "규격", "단가", "개수", "배송비", "합계", "링크"];
  const range = encodeURIComponent(`${quoteSheet(sheetName)}!A1:K1`);
  await googleRequest(spreadsheetId, `/values/${range}?valueInputOption=RAW`, {
    method: "PUT", body: JSON.stringify({ range: `${quoteSheet(sheetName)}!A1:K1`, majorDimension: "ROWS", values: [headers] }),
  });
  return headers;
}

export async function createGoogleSheetTabs(spreadsheetId: string, names: string[]) {
  const existing = await inspectGoogleSpreadsheet(spreadsheetId);
  const existingNames = new Set(existing.map((sheet) => sheet.title));
  const missing = [...new Set(names.map((name) => name.trim()).filter(Boolean))].filter((name) => !existingNames.has(name));
  if (missing.length) await googleRequest(spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
  });
  return { created: missing, existing: names.filter((name) => existingNames.has(name)) };
}

export async function testGoogleSheetConnection(spreadsheetId: string, sheetName: string) {
  const sheets = await inspectGoogleSpreadsheet(spreadsheetId);
  if (!sheets.some((sheet) => sheet.title === sheetName)) throw new UserFacingError(`${sheetName} 탭을 찾을 수 없습니다.`);
  const range = encodeURIComponent(`${quoteSheet(sheetName)}!A1:B3`);
  await googleRequest(spreadsheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ range: `${quoteSheet(sheetName)}!A1:B3`, majorDimension: "ROWS", values: [["플랫폼 연결 시험", "정상"], ["학생 데이터", "사용 안 함"], ["확인 시각", new Date().toISOString()]] }),
  });
  return { sheetName, testedAt: new Date().toISOString() };
}

function quoteSheet(name: string) {
  return `'${name.replaceAll("'", "''")}'`;
}
