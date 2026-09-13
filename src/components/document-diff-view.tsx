"use client";

import { useId, useMemo, useState } from "react";
import { compareVersionContents, readableDiffValue, type CellDiff, type ChangeKind, type FieldDiff, type TextPart } from "@/lib/document-diff";
import { versionTime, type DocumentVersion, type VersionComparison } from "@/lib/document-version-types";

const labels: Record<ChangeKind, string> = { same: "변경 없음", added: "추가", deleted: "삭제", modified: "수정", unknown: "확인 필요" };
const statuses: Record<string, string> = { draft: "작성 중", approved: "승인됨", pending: "승인 대기", feedback: "수정 요청", submitted: "검토 대기", reviewed: "확인 완료", reapproval_required: "재승인 필요", withdrawn: "철회됨" };

function Value({ value, parts, side, kind }: { value: unknown; parts?: TextPart[]; side: "a" | "b"; kind: ChangeKind }) {
  const text = readableDiffValue(value);
  return <div className={`version-value ${(kind === "added" || kind === "modified" && !parts) && side === "b" ? "diff-added" : (kind === "deleted" || kind === "modified" && !parts) && side === "a" ? "diff-deleted" : ""}`}>
    {parts ? parts.filter(part => side === "a" ? part.kind !== "added" : part.kind !== "deleted").map((part, index) => part.kind === "added"
      ? <ins className="diff-added" key={index}>{part.text}</ins>
      : part.kind === "deleted" ? <del className="diff-deleted" key={index}>{part.text}</del>
        : <span key={index}>{part.text}</span>)
      : text}
  </div>;
}

function EmptyValue() {
  return <div className="version-empty">내용 없음</div>;
}

function sideValue(field: CellDiff, side: "a" | "b") {
  const value = side === "a" ? field.before : field.after;
  return field.key === "status" ? statuses[String(value)] ?? value : value;
}

function isMissing(field: CellDiff, side: "a" | "b") {
  return side === "a" ? field.kind === "added" : field.kind === "deleted";
}

function CellValue({ field, side }: { field: CellDiff; side: "a" | "b" }) {
  if (isMissing(field, side)) return <EmptyValue />;
  return <Value value={sideValue(field, side)} parts={field.parts} side={side} kind={field.kind} />;
}

function TableSide({ field, side, all }: { field: FieldDiff; side: "a" | "b"; all: boolean }) {
  const rows = field.rows?.filter(row => all || row.kind !== "same");
  if (!rows?.length) return isMissing(field, side) ? <EmptyValue /> : <Value value={side === "a" ? field.before : field.after} side={side} kind={field.kind} />;
  return <div className="version-table-side">
    {rows.map((row, index) => {
      const rowIndex = side === "a" ? row.beforeIndex : row.afterIndex;
      const rowMissing = side === "a" ? row.kind === "added" : row.kind === "deleted";
      return <section className="version-row" key={`${row.beforeIndex}:${row.afterIndex}:${index}`}>
        <div className="toolbar">
          <strong>{rowIndex === null ? "내용 없음" : `${rowIndex + 1}행`}</strong>
          <span className={`version-change ${row.kind}`}>{row.moved ? "순서 변경" : labels[row.kind]}</span>
        </div>
        {rowMissing ? <EmptyValue /> : row.cells.filter(cell => all || cell.kind !== "same" || row.moved).map(cell => <div key={cell.key}><h4>{cell.label}</h4><CellValue field={cell} side={side} /></div>)}
      </section>;
    })}
  </div>;
}

function FieldSide({ field, side, all }: { field: FieldDiff; side: "a" | "b"; all: boolean }) {
  const heading = side === "a" && field.beforeLabel ? field.beforeLabel : field.label;
  return <section className={`version-document-field-side side-${side}`}>
    <div className="version-field-heading">
      <h3>{heading}</h3>
      <span className={`version-change ${field.kind}`}>{labels[field.kind]}</span>
    </div>
    {field.note ? <p className="section-subtitle">{field.note}</p> : null}
    {field.rows ? <TableSide field={field} side={side} all={all} /> : <CellValue field={field} side={side} />}
  </section>;
}

function FieldPair({ field, id, all }: { field: FieldDiff; id?: string; all: boolean }) {
  return <div className="version-document-row" id={id} data-field-key={field.key}>
    <FieldSide field={field} side="a" all={all} />
    <FieldSide field={field} side="b" all={all} />
  </div>;
}

function Original({ version, side }: { version: DocumentVersion; side: string }) {
  const fields = new Map(version.fields.map(field => [field.id, field.label]));
  return <details className="version-original"><summary>{side} 원문 보기 · {version.label}</summary>
    <p>{versionTime(version.eventAt)} · 한국 시간</p>
    {!version.valid ? <p className="warning-box">일부 원문 구조를 확인할 수 없습니다.</p> : null}
    {version.unreadableSource !== undefined ? <Value value={version.unreadableSource} side="a" kind="same" /> : null}
    {Object.entries(version.values).map(([key, value]) => <section key={key}><h4>{fields.get(key) ?? key}</h4><Value value={value} side="a" kind="same" /></section>)}
    {version.roles.map(role => <section key={role.userId}><h4>팀원 역할 · {role.label}</h4><Value value={role.description} side="a" kind="same" /></section>)}
  </details>;
}

export function DocumentDiffView({ comparison }: { comparison: VersionComparison }) {
  const [all, setAll] = useState(true);
  const prefix = useId();
  const diff = useMemo(() => compareVersionContents(comparison.a, comparison.b), [comparison]);
  const changed = diff.fields.filter(field => field.kind !== "same");
  const display = all ? diff.fields : changed;
  const metadata = diff.metadata.filter(field => field.kind !== "same");
  const count = (kind: ChangeKind) => changed.filter(field => field.kind === kind).length;
  return <div className="version-result">
    <div className="version-result-head">
      <p className="section-subtitle">두 문서 전체를 좌우에 고정해 표시합니다. 같은 항목은 같은 줄과 높이를 사용하며, 한쪽에 없으면 ‘내용 없음’ 공간을 유지합니다.</p>
      <div className="toolbar-group">
        <button className={`button ${all ? "" : "secondary"}`} aria-pressed={all} onClick={() => setAll(true)}>전체 문서</button>
        <button className={`button ${!all ? "" : "secondary"}`} aria-pressed={!all} onClick={() => setAll(false)}>변경 항목만 {changed.length}개</button>
      </div>
      <p role="status">추가 {count("added")} · 삭제 {count("deleted")} · 수정 {count("modified")} · 확인 필요 {count("unknown")}</p>
      <p className="version-legend"><ins className="diff-added">추가 · 굵게</ins> <del className="diff-deleted">삭제 · 취소선</del> <span>수정은 A의 삭제와 B의 추가로 표시합니다.</span></p>
      {diff.issues.map(issue => <p className="notice-box" key={issue}>{issue}</p>)}
      {!changed.length ? <p className="notice-box">{!comparison.a.valid || !comparison.b.valid ? "원문 확인이 필요해 전체 내용의 동일 여부를 판단하지 않았습니다." : "선택한 두 버전의 본문과 팀원 역할이 같습니다."}{metadata.length ? " 상태·피드백 또는 양식 변화는 아래에서 확인하세요." : ""}</p> : null}
      {changed.length ? <nav className="version-jumps" aria-label="변경 항목으로 이동">{changed.map(field => <button className="button ghost" key={field.key} onClick={() => document.getElementById(`${prefix}-${field.key}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>{field.label}</button>)}</nav> : null}
    </div>
    <div className="version-document-scroll" tabIndex={0} aria-label="문서 전체 좌우 비교">
      <div className="version-document-grid">
        <div className="version-document-head">
          <div className="version-document-column-head side-a"><b>A · {comparison.a.label}</b><span>{versionTime(comparison.a.eventAt)}</span></div>
          <div className="version-document-column-head side-b"><b>B · {comparison.b.label}</b><span>{versionTime(comparison.b.eventAt)}</span></div>
        </div>
        {display.map(field => <FieldPair field={field} key={field.key} id={`${prefix}-${field.key}`} all={all} />)}
        {!display.length ? <p className="version-document-no-changes">표시할 변경 항목이 없습니다.</p> : null}
      </div>
    </div>
    <p className="section-subtitle">조회한 내용으로 고정해 표시합니다. 기록 시각과 작업자는 당시 문장 전체의 작성 시각·작성자를 뜻하지 않습니다.</p>
    <details className="version-original"><summary>상태·교사 피드백·양식 변화 ({metadata.length}개)</summary>{metadata.map(field => <FieldPair key={field.key} field={field} all />)}{!metadata.length ? <p>변경이 없습니다.</p> : null}</details>
    <Original version={comparison.a} side="A" /><Original version={comparison.b} side="B" />
  </div>;
}
