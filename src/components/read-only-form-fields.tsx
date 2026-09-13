import type { FormFieldDefinition } from "@/lib/club-settings";

export function ReadOnlyFormFields({ fields, values }: { fields: FormFieldDefinition[]; values: Record<string, unknown> }) {
  return <>{fields.map(field => {
    if (field.kind === "heading") return <h3 className="section-heading" key={field.id}>{field.label}</h3>;
    let value = values[field.id];
    if (typeof value === "string" && ["table", "multiple_choice", "checkbox"].includes(field.kind)) {
      try { value = JSON.parse(value); } catch { /* Preserve malformed historical text for review. */ }
    }
    const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
    return <div className="plan-field" key={field.id}><div className="label">{field.label}</div>
      {field.kind === "table" && Array.isArray(value) ? <div className="table-wrap"><table className="data-table"><thead><tr>{field.columns?.map(column => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{value.map((row, index) => <tr key={index}>{field.columns?.map(column => <td key={column.id}>{row && typeof row === "object" ? String(row[column.id] ?? "") : String(row ?? "")}</td>)}</tr>)}</tbody></table>{empty ? <span>미작성</span> : null}</div>
        : <div className="report-read-value">{empty ? "미작성" : typeof value === "boolean" ? (value ? "예" : "아니요") : Array.isArray(value) ? value.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}</div>}
    </div>;
  })}</>;
}
