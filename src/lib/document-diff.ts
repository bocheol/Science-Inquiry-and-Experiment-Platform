import type { FormFieldDefinition } from "@/lib/club-settings";
import type { DocumentVersion } from "@/lib/document-version-types";

export type ChangeKind = "same" | "added" | "deleted" | "modified" | "unknown";
export type TextPart = { kind: "same" | "added" | "deleted"; text: string };
export type CellDiff = { key: string; label: string; before: unknown; after: unknown; kind: ChangeKind; parts?: TextPart[] };
export type RowDiff = { beforeIndex: number | null; afterIndex: number | null; kind: ChangeKind; moved?: boolean; cells: CellDiff[] };
export type FieldDiff = CellDiff & { group: "body" | "role" | "metadata"; beforeLabel?: string; rows?: RowDiff[]; note?: string; limited?: boolean };
export type DocumentDiff = { fields: FieldDiff[]; metadata: FieldDiff[]; issues: string[]; limited: boolean };
const missing = Symbol("missing");
type Value = unknown | typeof missing;
type Budget = { remaining: number; deadline: number };
function canonical(value: Value): string {
  if (value === missing) return "missing";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}
export function readableDiffValue(value: unknown) {
  if (value === missing || value === undefined) return "항목 없음";
  if (value === null) return "미작성 (null)";
  if (value === "") return "미작성";
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function changeKind(a: Value, b: Value): ChangeKind {
  if (canonical(a) === canonical(b)) return "same";
  if (a === missing) return "added";
  if (b === missing) return "deleted";
  return "modified";
}
function spend(budget: Budget, cost: number) {
  budget.remaining -= cost;
  if (budget.remaining < 0 || Date.now() > budget.deadline) throw new Error("diff-budget");
}
type Edit = { kind: "same" | "added" | "deleted"; a?: number; b?: number };
function align(a: string[], b: string[], budget: Budget): Edit[] {
  spend(budget, (a.length + 1) * (b.length + 1));
  const width = b.length + 1;
  const matrix = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    if (i % 32 === 0) spend(budget, 0);
    for (let j = b.length - 1; j >= 0; j--) matrix[i * width + j] = a[i] === b[j] ? 1 + matrix[(i + 1) * width + j + 1] : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  const result: Edit[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) result.push({ kind: "same", a: i++, b: j++ });
    else if (i < a.length && (j === b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) result.push({ kind: "deleted", a: i++ });
    else result.push({ kind: "added", b: j++ });
  }
  return result;
}
function coalesce(parts: TextPart[]) {
  const result: TextPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    if (result.at(-1)?.kind === part.kind) result[result.length - 1].text += part.text;
    else result.push({ ...part });
  }
  return result;
}
function textDiff(a: string, b: string, budget: Budget): TextPart[] {
  if (a === b) return [{ kind: "same", text: a }];
  if (a.length > 40000 || b.length > 40000) throw new Error("diff-budget");
  const wordsA = a.match(/\s+|[^\s]+/gu) ?? [], wordsB = b.match(/\s+|[^\s]+/gu) ?? [];
  const edits = align(wordsA, wordsB, budget);
  const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
  const parts: TextPart[] = [];
  for (let i = 0; i < edits.length;) {
    if (edits[i].kind === "same") { parts.push({ kind: "same", text: wordsA[edits[i].a!] }); i++; continue; }
    let left = "", right = "";
    while (i < edits.length && edits[i].kind !== "same") {
      const edit = edits[i++];
      if (edit.a !== undefined) left += wordsA[edit.a];
      if (edit.b !== undefined) right += wordsB[edit.b];
    }
    if (!left || !right) { if (left) parts.push({ kind: "deleted", text: left }); if (right) parts.push({ kind: "added", text: right }); continue; }
    const ga = [...segmenter.segment(left)].map(s => s.segment), gb = [...segmenter.segment(right)].map(s => s.segment);
    for (const edit of align(ga, gb, budget)) parts.push({ kind: edit.kind, text: edit.a !== undefined ? ga[edit.a] : gb[edit.b!] });
  }
  return coalesce(parts);
}
export function diffText(a: string, b: string) { return textDiff(a, b, { remaining: 250000, deadline: Date.now() + 200 }); }

function normalize(value: Value, field?: FormFieldDefinition): { value: Value; invalid?: boolean } {
  if (value === missing || !field) return { value };
  if (["table", "multiple_choice", "checkbox"].includes(field.kind)) {
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { return { value, invalid: true }; } }
    if (field.kind === "checkbox") return { value, invalid: typeof value !== "boolean" && value !== null };
    if (!Array.isArray(value)) return { value, invalid: value !== null };
    if (field.kind === "multiple_choice") {
      if (value.some(item => typeof item !== "string")) return { value, invalid: true };
      return { value: [...new Set(value)].sort() };
    }
    if (value.some(row => !row || typeof row !== "object" || Array.isArray(row))) return { value, invalid: true };
  }
  if (field.kind === "number" && typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return { value: Number(value) };
  return { value };
}
function cell(key: string, label: string, before: Value, after: Value, budget: Budget): CellDiff {
  const kind = changeKind(before, after);
  return { key, label, before: before === missing ? undefined : before, after: after === missing ? undefined : after, kind,
    parts: kind !== "same" && typeof before === "string" && typeof after === "string" ? textDiff(before, after, budget) : undefined };
}
function tableDiff(a: Record<string, unknown>[], b: Record<string, unknown>[], left: FormFieldDefinition | undefined, right: FormFieldDefinition | undefined, budget: Budget) {
  const keys = Array.from(new Set([...(right?.columns ?? left?.columns ?? []).map(c => c.id), ...(left?.columns ?? []).map(c => c.id), ...a.flatMap(Object.keys), ...b.flatMap(Object.keys)]));
  const labels = new Map([...(left?.columns ?? []), ...(right?.columns ?? [])].map(c => [c.id, c.label]));
  const row = (ai: number | null, bi: number | null, moved = false): RowDiff => ({
    beforeIndex: ai, afterIndex: bi, moved,
    kind: moved ? "modified" : ai === null ? "added" : bi === null ? "deleted" : changeKind(a[ai], b[bi]),
    cells: keys.map(key => cell(key, labels.get(key) ?? key, ai !== null && Object.hasOwn(a[ai], key) ? a[ai][key] : missing, bi !== null && Object.hasOwn(b[bi], key) ? b[bi][key] : missing, budget)),
  });
  const ca = a.map(canonical), cb = b.map(canonical);
  const edits = align(ca, cb, budget), rows: RowDiff[] = [];
  const deleted = edits.filter(e => e.kind === "deleted"), added = edits.filter(e => e.kind === "added");
  const movedA = new Map<number, number>(), movedB = new Set<number>();
  for (const edit of deleted) {
    const key = ca[edit.a!], matches = added.filter(e => cb[e.b!] === key);
    if (matches.length === 1 && ca.filter(v => v === key).length === 1 && cb.filter(v => v === key).length === 1) { movedA.set(edit.a!, matches[0].b!); movedB.add(matches[0].b!); }
  }
  for (let i = 0; i < edits.length;) {
    const edit = edits[i];
    if (edit.kind === "same") { rows.push(row(edit.a!, edit.b!)); i++; continue; }
    const removed: number[] = [], inserted: number[] = [];
    while (i < edits.length && edits[i].kind !== "same") {
      const next = edits[i++];
      if (next.a !== undefined) {
        if (movedA.has(next.a)) rows.push(row(next.a, movedA.get(next.a)!, true));
        else removed.push(next.a);
      }
      if (next.b !== undefined && !movedB.has(next.b)) inserted.push(next.b);
    }
    const unique = removed.length === 1 && inserted.length === 1 && ca.filter(v => v === ca[removed[0]]).length === 1 && cb.filter(v => v === cb[inserted[0]]).length === 1;
    if (unique && canonical(left?.columns) === canonical(right?.columns)) rows.push(row(removed[0], inserted[0]));
    else { removed.forEach(ai => rows.push(row(ai, null))); inserted.forEach(bi => rows.push(row(null, bi))); }
  }
  return rows;
}

export function compareVersionContents(a: DocumentVersion, b: DocumentVersion): DocumentDiff {
  const budget = { remaining: 1000000, deadline: Date.now() + 200 };
  const issues = [...new Set([...a.issues, ...b.issues])];
  const left = new Map(a.fields.map(f => [f.id, f])), right = new Map(b.fields.map(f => [f.id, f]));
  const keys = [...new Set([...b.fields.map(f => f.id), ...a.fields.map(f => f.id), ...Object.keys(a.values), ...Object.keys(b.values)])];
  const fields: FieldDiff[] = [], metadata: FieldDiff[] = [];
  let limited = false;
  for (const key of keys) {
    const af = left.get(key), bf = right.get(key);
    if (!Object.hasOwn(a.values, key) && !Object.hasOwn(b.values, key)) continue;
    const av = Object.hasOwn(a.values, key) ? a.values[key] : missing, bv = Object.hasOwn(b.values, key) ? b.values[key] : missing;
    const aa = normalize(av, af), bb = normalize(bv, bf);
    const base: FieldDiff = { key, label: bf?.label ?? af?.label ?? key, beforeLabel: af?.label, group: "body", before: av === missing ? undefined : av, after: bv === missing ? undefined : bv,
      kind: !a.valid || !b.valid || aa.invalid || bb.invalid ? "unknown" : changeKind(aa.value, bb.value) };
    if (base.kind === "unknown") base.note = "이 항목의 형식 또는 원문을 확인할 수 없어 차이를 계산하지 않았습니다.";
    else if (base.kind !== "same") {
      try {
        spend(budget, 0);
        if (typeof aa.value === "string" && typeof bb.value === "string") base.parts = textDiff(aa.value, bb.value, budget);
        if ((af?.kind === "table" || bf?.kind === "table") && Array.isArray(aa.value) && Array.isArray(bb.value)) {
          base.rows = tableDiff(aa.value as Record<string, unknown>[], bb.value as Record<string, unknown>[], af, bf, budget);
          base.note = "행 식별자가 없는 표는 동일한 행을 먼저 대응합니다. 모호한 행은 추가·삭제로 표시합니다.";
        }
      } catch { limited = true; base.limited = true; base.note = "긴 내용은 항목 단위로 표시합니다. A/B 원문은 그대로 보존됩니다."; }
    }
    fields.push(base);
  }
  const roleA = new Map(a.roles.map(r => [r.userId, r])), roleB = new Map(b.roles.map(r => [r.userId, r]));
  for (const id of new Set([...roleA.keys(), ...roleB.keys()])) {
    const ar = roleA.get(id), br = roleB.get(id);
    const base: FieldDiff = { key: `role:${id}`, label: `팀원 역할 · ${br?.label ?? ar?.label}`, before: ar?.description, after: br?.description, group: "role", kind: !a.valid || !b.valid ? "unknown" : changeKind(ar ? ar.description : missing, br ? br.description : missing), note: "이름은 현재 계정의 표시 정보이며, 당시 역할은 저장된 사용자 ID로 대응했습니다." };
    if (base.kind === "modified" && ar && br) { try { base.parts = textDiff(ar.description, br.description, budget); } catch { base.limited = true; limited = true; } }
    fields.push(base);
  }
  for (const [key, label, av, bv] of [["status", "문서 상태", a.status, b.status], ["feedback", "교사 피드백", a.feedback, b.feedback]] as const) {
    metadata.push({ key, label, before: av, after: bv, group: "metadata", kind: changeKind(av, bv) });
  }
  if (a.definitionVerified && b.definitionVerified && canonical(a.fields) !== canonical(b.fields)) metadata.push({ key: "definition", label: "양식·항목명·순서", before: a.fields, after: b.fields, kind: "modified", group: "metadata" });
  return { fields, metadata, issues, limited };
}
