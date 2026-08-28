import { GoogleAuth } from "google-auth-library";
import type { MaterialItem } from "@/lib/types";

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID ?? "1Ia5xoZZDv3b4sVq3la8POFNE_QVHEuLhitS-YC_QBVg";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

type TeamSheetInput = {
  classNumber: number;
  teamNumber: number;
  leaderLoginId: string;
  leaderName: string;
  items: MaterialItem[];
};

function configuredCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 형식이 올바르지 않습니다.");
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

async function googleRequest<T>(path: string, init: RequestInit = {}) {
  const headers = await authorizedHeaders();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    ...init,
    headers: { ...headers, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const result = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) {
    const googleMessage = result.error?.message ?? "";
    if (response.status === 403 && /has not been used|disabled/i.test(googleMessage)) {
      throw new Error("Google Cloud에서 Google Sheets API를 활성화해야 합니다.");
    }
    if (response.status === 403) {
      throw new Error("서비스 계정에 준비물 시트 편집 권한이 있는지 확인해 주세요.");
    }
    throw new Error(googleMessage || `Google Sheets 요청 실패 (${response.status})`);
  }
  return result;
}

function quoteSheet(name: string) {
  return `'${name.replaceAll("'", "''")}'`;
}

export async function syncMaterialsToGoogleSheet(input: TeamSheetInput) {
  if (!googleSheetsConfigured()) throw new Error("Google Sheets 서비스 계정 연결 대기 중");
  const sheetName = `${input.classNumber}반`;
  const metadata = await googleRequest<{ sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }>(
    "?fields=sheets.properties(sheetId,title)",
  );
  const sheetId = metadata.sheets?.find((sheet) => sheet.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId == null) throw new Error(`${sheetName} 탭을 찾을 수 없습니다.`);

  const range = encodeURIComponent(`${quoteSheet(sheetName)}!A1:J200`);
  const valuesResult = await googleRequest<{ values?: unknown[][] }>(`/values/${range}?valueRenderOption=FORMULA`);
  const rows = valuesResult.values ?? [];
  const startIndex = rows.findIndex((row, index) => index >= 7 && String(row?.[0] ?? "") === String(input.teamNumber));
  const totalIndex = rows.findIndex((row, index) => index > startIndex && String(row?.[0] ?? "").trim() === `${input.teamNumber}조`);
  if (startIndex < 0 || totalIndex < 0) throw new Error(`${sheetName}의 ${input.teamNumber}조 입력 영역을 찾을 수 없습니다.`);

  let capacity = totalIndex - startIndex;
  let currentTotalIndex = totalIndex;
  if (input.items.length > capacity) {
    const extra = input.items.length - capacity;
    await googleRequest(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: totalIndex, endIndex: totalIndex + extra },
            inheritFromBefore: true,
          },
        }],
      }),
    });
    capacity = input.items.length;
    currentTotalIndex += extra;
  }

  const valueRows = Array.from({ length: capacity }, (_, offset) => {
    const rowNumber = startIndex + offset + 1;
    const item = input.items[offset];
    if (!item) {
      return [offset === 0 ? input.teamNumber : "", offset === 0 ? input.leaderLoginId : "", offset === 0 ? input.leaderName : "", "", "", "", "", "", `=IF(COUNTA(D${rowNumber}:H${rowNumber})=0,"",(F${rowNumber}*G${rowNumber})+H${rowNumber})`, ""];
    }
    return [
      offset === 0 ? input.teamNumber : "",
      offset === 0 ? input.leaderLoginId : "",
      offset === 0 ? input.leaderName : "",
      item.name,
      item.specification,
      item.unitPrice,
      item.quantity,
      item.shipping,
      `=(F${rowNumber}*G${rowNumber})+H${rowNumber}`,
      item.link,
    ];
  });
  const totalRowNumber = currentTotalIndex + 1;
  valueRows.push([`${input.teamNumber}조`, "", "", "", "", "", "", "", `=SUM(I${startIndex + 1}:I${currentTotalIndex})`, ""]);
  const writeRange = `${quoteSheet(sheetName)}!A${startIndex + 1}:J${totalRowNumber}`;
  await googleRequest("/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: [{ range: writeRange, majorDimension: "ROWS", values: valueRows }],
    }),
  });
  return { sheetName, startRow: startIndex + 1, totalRow: totalRowNumber };
}
