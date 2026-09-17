export function materialSheetUrl(spreadsheetId: unknown): string | null {
  if (typeof spreadsheetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) return null;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}
