// m is the stored request, u is its ORIGINAL submitter (never the retrying actor).
// A receipt or saved transfer target is not inferred to be practice data.
export const PRACTICE_MATERIAL_SQL = "(COALESCE(u.account_type, 'standard') = 'demo' AND m.sync_snapshot IS NULL AND m.sync_status <> 'synced')";
export const PRACTICE_MATERIAL_LABEL = "연습 제출 · 시트 미전송";
