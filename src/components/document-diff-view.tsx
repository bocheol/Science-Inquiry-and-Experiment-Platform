"use client";

import { useId, useMemo, useState } from "react";
import { compareVersionContents, readableDiffValue, type CellDiff, type ChangeKind, type FieldDiff, type TextPart } from "@/lib/document-diff";
import { versionTime, type DocumentVersion, type VersionComparison } from "@/lib/document-version-types";

const labels: Record<ChangeKind, string> = { same: "변경 없음", added: "추가", deleted: "삭제", modified: "수정", unknown: "확인 필요" };
const statuses: Record<string, string> = { draft: "작성 중", approved: "승인됨", pending: "승인 대기", feedback: "수정 요청", submitted: "검토 대기", reviewed: "확인 완료", reapproval_required: "재승인 필요", withdrawn: "철회됨" };
function Value({ value, parts, side, kind }: { value: unknown; parts?: TextPart[]; side: "a" | "b"; kind: ChangeKind }) {
  const [expanded, setExpanded] = useState(false);
  const text = readableDiffValue(value);
  const long = parts ? parts.some(p => p.kind === "same" && p.text.length > 700) : text.length > 1600;
  return <div>
    <div className={`version-value ${(kind === "added" || kind === "modified" && !parts) && side === "b" ? "diff-added" : (kind === "deleted" || kind === "modified" && !parts) && side === "a" ? "diff-deleted" : ""}`}>
      {parts ? parts.filter(p => side === "a" ? p.kind !== "added" : p.kind !== "deleted").map((part, i) => part.kind === "added"
        ? <ins className="diff-added" key={i}>{part.text}</ins>
        : part.kind === "deleted" ? <del className="diff-deleted" key={i}>{part.text}</del>
          : <span key={i}>{!expanded && part.text.length > 700 ? `${part.text.slice(0, 250)}\n… 같은 내용 생략 …\n${part.text.slice(-250)}` : part.text}</span>)
        : !expanded && long ? `${text.slice(0, 1600)}\n…` : text}
    </div>
    {long ? <button className="button ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "내용 접기" : "전체 문맥 보기"}</button> : null}
  </div>;
}
function Pair({ field }: { field: CellDiff }) {
  const before = field.key === "status" ? statuses[String(field.before)] ?? field.before : field.before;
  const after = field.key === "status" ? statuses[String(field.after)] ?? field.after : field.after;
  return <div className="version-pair">
    <div className="version-side"><b className="version-side-label">A · 기준 내용</b><Value value={before} parts={field.parts} side="a" kind={field.kind} /></div>
    <div className="version-side"><b className="version-side-label">B · 비교 내용</b><Value value={after} parts={field.parts} side="b" kind={field.kind} /></div>
  </div>;
}
function Field({ field, id, all }: { field: FieldDiff; id?: string; all: boolean }) {
  const [rowLimit, setRowLimit] = useState(30);
  const rows = field.rows?.filter(row => all || row.kind !== "same");
  return <article className="version-field" id={id}>
    <div className="toolbar"><h3>{field.label}</h3><span className={`version-change ${field.kind}`}>{labels[field.kind]}</span></div>
    {field.beforeLabel && field.beforeLabel !== field.label ? <p className="section-subtitle">A 항목명: {field.beforeLabel}</p> : null}
    {field.note ? <p className="section-subtitle">{field.note}</p> : null}
    {rows ? <>
      {rows.slice(0, rowLimit).map((row, i) => <section className="version-row" key={`${row.beforeIndex}:${row.afterIndex}:${i}`}>
        <div className="toolbar"><strong>A {row.beforeIndex === null ? "없음" : `${row.beforeIndex + 1}행`} → B {row.afterIndex === null ? "없음" : `${row.afterIndex + 1}행`}</strong><span className={`version-change ${row.kind}`}>{row.moved ? "순서 변경" : labels[row.kind]}</span></div>
        {row.cells.filter(c => all || c.kind !== "same" || row.moved).map(c => <div key={c.key}><h4>{c.label}</h4><Pair field={c} /></div>)}
      </section>)}
      {rows.length > rowLimit ? <button className="button secondary" onClick={() => setRowLimit(rowLimit + 30)}>다음 변경 행 보기 ({rows.length - rowLimit}개 남음)</button> : null}
      <details className="version-original"><summary>표 원문 보기</summary><Pair field={field} /></details>
    </> : <Pair field={field} />}
  </article>;
}
function Original({ version, side }: { version: DocumentVersion; side: string }) {
  const fields = new Map(version.fields.map(f => [f.id, f.label]));
  return <details className="version-original"><summary>{side} 원문 보기 · {version.label}</summary>
    <p>{versionTime(version.eventAt)} · 한국 시간</p>
    {!version.valid ? <p className="warning-box">일부 원문 구조를 확인할 수 없습니다.</p> : null}
    {version.unreadableSource !== undefined ? <Value value={version.unreadableSource} side="a" kind="same" /> : null}
    {Object.entries(version.values).map(([key, value]) => <section key={key}><h4>{fields.get(key) ?? key}</h4><Value value={value} side="a" kind="same" /></section>)}
    {version.roles.map(role => <section key={role.userId}><h4>팀원 역할 · {role.label}</h4><Value value={role.description} side="a" kind="same" /></section>)}
  </details>;
}
export function DocumentDiffView({ comparison }: { comparison: VersionComparison }) {
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(30);
  const prefix = useId();
  const diff = useMemo(() => compareVersionContents(comparison.a, comparison.b), [comparison]);
  const changed = diff.fields.filter(f => f.kind !== "same");
  const display = all ? diff.fields : changed;
  const metadata = diff.metadata.filter(f => f.kind !== "same");
  const count = (kind: ChangeKind) => changed.filter(f => f.kind === kind).length;
  return <div className="version-result">
    <div className="version-result-head">
      <div className="version-pair"><p><b>A · {comparison.a.label}</b><br />{versionTime(comparison.a.eventAt)}</p><p><b>B · {comparison.b.label}</b><br />{versionTime(comparison.b.eventAt)}</p></div>
      <p className="section-subtitle">조회한 내용으로 고정해 표시합니다. 기록 시각과 작업자는 당시 문장 전체의 작성 시각·작성자를 뜻하지 않습니다.</p>
      <div className="toolbar-group"><button className={`button ${!all ? "" : "secondary"}`} aria-pressed={!all} onClick={() => { setAll(false); setLimit(30); }}>변경 항목 {changed.length}개</button><button className={`button ${all ? "" : "secondary"}`} aria-pressed={all} onClick={() => { setAll(true); setLimit(30); }}>전체 항목</button></div>
      <p role="status">추가 {count("added")} · 삭제 {count("deleted")} · 수정 {count("modified")} · 확인 필요 {count("unknown")}</p>
      <p className="version-legend"><ins className="diff-added">추가 · 굵게</ins> <del className="diff-deleted">삭제 · 취소선</del> <span>수정은 A의 삭제와 B의 추가로 표시합니다.</span></p>
      {diff.issues.map(issue => <p className="notice-box" key={issue}>{issue}</p>)}
      {!changed.length ? <p className="notice-box">{!comparison.a.valid || !comparison.b.valid ? "원문 확인이 필요해 전체 내용의 동일 여부를 판단하지 않았습니다." : "선택한 두 버전의 본문과 팀원 역할이 같습니다."}{metadata.length ? " 상태·피드백 또는 양식 변화는 아래에서 확인하세요." : ""}</p> : null}
      {changed.length ? <nav className="version-jumps" aria-label="변경 항목으로 이동">{changed.slice(0, 30).map(field => <button className="button ghost" key={field.key} onClick={() => document.getElementById(`${prefix}-${field.key}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>{field.label}</button>)}</nav> : null}
    </div>
    {display.slice(0, limit).map(field => <Field field={field} key={field.key} id={`${prefix}-${field.key}`} all={all} />)}
    {display.length > limit ? <button className="button secondary" onClick={() => setLimit(limit + 30)}>항목 더 보기 ({display.length - limit}개 남음)</button> : null}
    <details className="version-original"><summary>상태·교사 피드백·양식 변화 ({metadata.length}개)</summary>{metadata.map(field => <Field key={field.key} field={field} all />)}{!metadata.length ? <p>변경이 없습니다.</p> : null}</details>
    <Original version={comparison.a} side="A" /><Original version={comparison.b} side="B" />
  </div>;
}
