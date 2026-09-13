import type { FormFieldDefinition } from "@/lib/club-settings";

function valueView(value: unknown) {
  if (value == null || value === "") return <span className="muted-text">미작성</span>;
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted-text">미작성</span>;
    return <div className="table-wrap"><table className="data-table"><tbody>{value.map((row, rowIndex) =>
      <tr key={rowIndex}>{(row && typeof row === "object" ? Object.values(row as Record<string, unknown>) : [row])
        .map((cell, cellIndex) => <td key={cellIndex}>{String(cell ?? "")}</td>)}</tr>)}</tbody></table></div>;
  }
  return <div className="report-read-value">{typeof value === "object" ? JSON.stringify(value) : String(value)}</div>;
}

export function ReadOnlyCycleDocument({ title, description, fields, formData, roles }: {
  title: string;
  description?: string;
  fields: FormFieldDefinition[];
  formData: Record<string, unknown>;
  roles?: Array<{ userId: string; name: string; loginId: string; isLeader: boolean; isActive: boolean; description: string }>;
}) {
  return <section className="card card-body">
    <div className="page-title"><div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div><span className="badge">읽기 전용</span></div>
    <div className="notice-box">완료된 탐구 회차의 고정 기록입니다. 내용과 이력은 변경할 수 없습니다.</div>
    {roles?.length ? <div className="table-wrap"><table className="data-table report-role-table"><thead><tr><th>학번</th><th>이름</th><th>구분</th><th>팀원별 역할</th></tr></thead><tbody>{roles.map((role) => <tr key={role.userId}><td>{role.loginId}</td><td>{role.name}{!role.isActive ? " (팀에서 제거됨)" : ""}</td><td>{role.isLeader ? "팀장" : "팀원"}</td><td>{role.description || "미작성"}</td></tr>)}</tbody></table></div> : null}
    {fields.map((field) => field.kind === "heading"
      ? <h2 className="section-heading" key={field.id}>{field.label}</h2>
      : <div className="plan-field" key={field.id}><div className="label">{field.label}</div>{valueView(formData[field.id])}</div>)}
  </section>;
}
