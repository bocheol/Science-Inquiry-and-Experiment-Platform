export async function prepareMaterialSheetTransfer(snapshot, operationId) {
  if (!globalThis.__syntheticSheetPrepare) throw new Error("This test must use its fixed synthetic batch");
  return globalThis.__syntheticSheetPrepare(snapshot, operationId);
}
export async function executeMaterialSheetTransfer(spreadsheetId, batch) {
  if (!globalThis.__syntheticSheetTransfer) throw new Error("Synthetic sheet transport not installed");
  return globalThis.__syntheticSheetTransfer(spreadsheetId, batch);
}
