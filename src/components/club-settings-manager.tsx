"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/components/toast-provider";
import type { ClubConfigType, ClubConfigVersion, ClubSettingsData, FormFieldDefinition, FormFieldKind } from "@/lib/club-settings";

const BASE_CONFIGS: Array<{ type: ClubConfigType; label: string; description: string }> = [
  { type: "plan", label: "탐구 계획서", description: "학생이 작성할 항목과 필수 여부" },
  { type: "report", label: "최종보고서", description: "최종 결과물의 항목과 검토 흐름" },
  { type: "materials", label: "준비물·Google Sheet", description: "준비물 입력 항목과 동아리별 시트 연결" },
  { type: "self_evaluation", label: "자기평가", description: "행동 기준과 성찰 질문" },
  { type: "peer_evaluation", label: "동료평가", description: "팀원 평가의 행동 기준" },
  { type: "exam", label: "시험", description: "공통·팀·개인 문항 수와 출제 범위" },
];

const FIELD_KINDS: Array<{ value: FormFieldKind; label: string }> = [
  { value: "heading", label: "구역 제목" }, { value: "short_text", label: "짧은 글" },
  { value: "long_text", label: "긴 글" }, { value: "number", label: "숫자" },
  { value: "date", label: "날짜" }, { value: "single_choice", label: "하나 선택" },
  { value: "multiple_choice", label: "여러 개 선택" }, { value: "checkbox", label: "확인 체크" },
  { value: "table", label: "표" },
];

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function fieldsOf(definition: Record<string, unknown>) { return Array.isArray(definition.fields) ? definition.fields as FormFieldDefinition[] : []; }
function latest(versions: ClubConfigVersion[], type: ClubConfigType, key = "default") {
  return versions.filter((version) => version.configType === type && version.configKey === key).sort((a, b) => b.versionNumber - a.versionNumber);
}
function responseFieldLabel(versions: ClubConfigVersion[], versionId: string, key: string) {
  const version = versions.find((item) => item.id === versionId);
  return fieldsOf(version?.definition ?? {}).find((field) => field.id === key)?.label ?? key;
}

export function ClubSettingsManager({ initialData }: { initialData: ClubSettingsData }) {
  const [data, setData] = useState(initialData);
  const [clubId, setClubId] = useState(initialData.clubs[0]?.id ?? "");
  const [editing, setEditing] = useState<ClubConfigVersion | null>(null);
  const [definition, setDefinition] = useState<Record<string, unknown>>({});
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [sheetResult, setSheetResult] = useState("");
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [sheetTabs, setSheetTabs] = useState<string[]>([]);
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const { showToast } = useToast();
  const club = data.clubs.find((item) => item.id === clubId) ?? data.clubs[0];
  const customKeys = useMemo(() => club ? [...new Set(club.versions.filter((version) => version.configType === "custom_tab").map((version) => version.configKey))] : [], [club]);

  async function refresh(preferredVersionId?: string) {
    const response = await fetch("/api/teacher/club-settings", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    setData(result);
    if (preferredVersionId) {
      const version = result.clubs.flatMap((item: ClubSettingsData["clubs"][number]) => item.versions).find((item: ClubConfigVersion) => item.id === preferredVersionId);
      if (version) openEditor(version);
    }
  }

  async function act(payload: Record<string, unknown>, success: string, preferredVersionId?: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/teacher/club-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      await refresh(preferredVersionId ?? result.versionId);
      showToast(success);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "처리하지 못했습니다.");
      return null;
    } finally { setBusy(false); }
  }

  function openEditor(version: ClubConfigVersion) {
    setEditing(version); setTitle(version.title); setDefinition(copy(version.definition)); setConfirmation(""); setSheetResult(""); setSheetHeaders([]); setSheetTabs([]); setError("");
  }

  async function save() {
    if (!editing) return;
    const result = await act({ action: "update_draft", versionId: editing.id, title, definition, expectedRevision: editing.revision }, "초안을 저장했습니다.", editing.id);
    if (result) setConfirmation("");
  }

  async function saveThenSheetAction(action: "inspect_sheet" | "create_sheet_tabs" | "test_sheet", success: string) {
    if (!editing) return null;
    setBusy(true); setError("");
    try {
      const saveResponse = await fetch("/api/teacher/club-settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update_draft", versionId: editing.id, title, definition, expectedRevision: editing.revision }),
      });
      const saveResult = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saveResult.message);
      const actionResponse = await fetch("/api/teacher/club-settings", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, versionId: editing.id }),
      });
      const result = await actionResponse.json();
      if (!actionResponse.ok) throw new Error(result.message);
      await refresh(editing.id);
      showToast(success);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "처리하지 못했습니다.");
      return null;
    } finally { setBusy(false); }
  }

  function updateField(index: number, patch: Partial<FormFieldDefinition>) {
    const fields = copy(fieldsOf(definition)); fields[index] = { ...fields[index], ...patch };
    if (patch.kind === "single_choice" || patch.kind === "multiple_choice") fields[index].options ??= ["선택지 1"];
    if (patch.kind === "table") fields[index].columns ??= [{ id: "column1", label: "열 1", kind: "short_text" }];
    setDefinition({ ...definition, fields });
  }

  function renderFields() {
    const fields = fieldsOf(definition);
    return <div className="stack">
      {fields.map((field, index) => <article className="discussion-note stack" key={`${field.id}-${index}`}>
        <div className="toolbar-group">
          <label className="label">화면 이름<input className="input" value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
          <label className="label">항목 종류<select className="select" value={field.kind} onChange={(event) => updateField(index, { kind: event.target.value as FormFieldKind })}>{FIELD_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
          <label><input type="checkbox" checked={Boolean(field.required)} onChange={(event) => updateField(index, { required: event.target.checked })} /> 필수</label>
          <button type="button" className="button ghost" onClick={() => setDefinition({ ...definition, fields: fields.filter((_, itemIndex) => itemIndex !== index) })}>삭제</button>
        </div>
        <label className="label">도움말<input className="input" value={field.help ?? ""} onChange={(event) => updateField(index, { help: event.target.value })} /></label>
        {(field.kind === "single_choice" || field.kind === "multiple_choice") ? <label className="label">선택지 (쉼표로 구분)<input className="input" value={(field.options ?? []).join(", ")} onChange={(event) => updateField(index, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label> : null}
        {field.kind === "table" ? <div className="stack"><b>표의 열</b>{(field.columns ?? []).map((column, columnIndex) => <div className="toolbar-group" key={`${column.id}-${columnIndex}`}><input className="input" aria-label="열 이름" value={column.label} onChange={(event) => { const columns = copy(field.columns ?? []); columns[columnIndex].label = event.target.value; updateField(index, { columns }); }} /><select className="select" aria-label="열 종류" value={column.kind} onChange={(event) => { const columns = copy(field.columns ?? []); columns[columnIndex].kind = event.target.value as "short_text" | "number" | "date"; updateField(index, { columns }); }}><option value="short_text">글</option><option value="number">숫자</option><option value="date">날짜</option></select><button type="button" className="button ghost" onClick={() => updateField(index, { columns: (field.columns ?? []).filter((_, itemIndex) => itemIndex !== columnIndex) })}>열 삭제</button></div>)}<button type="button" className="button secondary" onClick={() => updateField(index, { columns: [...(field.columns ?? []), { id: `column${(field.columns?.length ?? 0) + 1}`, label: `열 ${(field.columns?.length ?? 0) + 1}`, kind: "short_text" }] })}>열 추가</button></div> : null}
      </article>)}
      <button type="button" className="button secondary" onClick={() => setDefinition({ ...definition, fields: [...fields, { id: `field${fields.length + 1}`, label: `새 항목 ${fields.length + 1}`, kind: "long_text", required: false }] })}>항목 추가</button>
    </div>;
  }

  function renderDefinition() {
    if (!editing) return null;
    if (["plan", "report", "custom_tab"].includes(editing.configType)) return <div className="stack">
      <label className="label">학생에게 보이는 설명<textarea className="textarea" value={String(definition.description ?? "")} onChange={(event) => setDefinition({ ...definition, description: event.target.value })} /></label>
      {editing.configType === "custom_tab" ? <div className="toolbar-group"><label className="label">작성 단위<select className="select" value={String(definition.responseMode ?? "team")} onChange={(event) => setDefinition({ ...definition, responseMode: event.target.value })}><option value="team">팀이 함께 작성</option><option value="individual">학생별 작성</option></select></label><label className="label">처리 방식<select className="select" value={String(definition.workflow ?? "save")} onChange={(event) => setDefinition({ ...definition, workflow: event.target.value })}><option value="save">저장만</option><option value="review">교사 검토 포함</option></select></label><label><input type="checkbox" checked={Boolean(definition.useForExam)} onChange={(event) => setDefinition({ ...definition, useForExam: event.target.checked })} /> 시험 출제 자료로 사용</label></div> : null}
      {renderFields()}
    </div>;
    if (editing.configType === "materials") {
      const sheet = (definition.sheet ?? {}) as Record<string, unknown>;
      const mapping = (sheet.columnMapping ?? {}) as Record<string, string>;
      const mappingFields = [["submittedAt", "제출 시각"], ["teamName", "팀 이름"], ["leaderLoginId", "팀장 학번"], ["leaderName", "팀장 이름"], ["name", "품명 *"], ["specification", "규격"], ["unitPrice", "단가 *"], ["quantity", "개수 *"], ["shipping", "배송비"], ["total", "합계"], ["link", "링크 *"]];
      const structured = sheet.layout === "team_sections";
      return <div className="stack">
        <p className="notice-box">주소와 탭 이름을 입력한 뒤 바로 연결 확인을 누르세요. 현재 입력값을 자동 저장하고 읽기 전용으로 확인합니다.</p>
        {renderFields()}
        <h3>Google Sheet 연결</h3>
        <label className="label">연결 방식<select className="select" value={String(sheet.mode ?? "existing")} onChange={(event) => setDefinition({ ...definition, sheet: { ...sheet, mode: event.target.value } })}><option value="existing">기존 탭 연결</option><option value="managed">플랫폼이 관리할 빈 탭</option></select></label>
        <label className="label">Google Sheet 주소<input className="input" value={String(sheet.spreadsheetUrl ?? "")} placeholder="https://docs.google.com/spreadsheets/d/..." onChange={(event) => setDefinition({ ...definition, sheet: { ...sheet, spreadsheetUrl: event.target.value } })} /></label>
        <div className="toolbar-group">
          <label className="label">연결 시험용 빈 탭<input className="input" value={String(sheet.testSheetName ?? "")} placeholder="예: 플랫폼연결시험" onChange={(event) => setDefinition({ ...definition, sheet: { ...sheet, testSheetName: event.target.value } })} /></label>
          <label className="label">운영 탭{String(sheet.mode ?? "existing") === "existing" ? " (여러 개면 쉼표로 구분)" : ""}<input className="input" value={String(sheet.sheetName ?? "")} onChange={(event) => setDefinition({ ...definition, sheet: { ...sheet, sheetName: event.target.value } })} /></label>
        </div>
        <p className="section-subtitle">시험용 탭은 ‘양식’이나 운영 탭이 아닌 빈 탭을 사용합니다. 서비스 계정에는 이 문서의 편집 권한이 필요합니다.</p>
        <div className="toolbar-group">
          <button type="button" className="button secondary" disabled={busy} onClick={async () => {
            const result = await saveThenSheetAction("inspect_sheet", "현재 입력값을 저장하고 시트 연결을 확인했습니다.");
            if (result?.sheet) {
              setSheetHeaders(result.sheet.headers ?? []); setSheetTabs(result.sheet.tabs ?? []);
              const unsafeTestName = String(sheet.testSheetName ?? "") === "양식" || String(sheet.sheetName ?? "").split(",").map((name) => name.trim()).includes(String(sheet.testSheetName ?? ""));
              setDefinition((current) => { const currentSheet = (current.sheet ?? {}) as Record<string, unknown>; return { ...current, sheet: { ...currentSheet, layout: result.sheet.layout, headerRow: result.sheet.headerRow, ...(unsafeTestName ? { testSheetName: "플랫폼연결시험" } : {}) } }; });
              const missing = (result.sheet.missingOperatingTabs ?? []) as string[];
              setSheetResult(`${result.sheet.operatingTabFound ? "운영 탭 모두 확인" : `찾지 못한 운영 탭: ${missing.join(", ")}`} · 열 제목 ${result.sheet.headerRow}행 ${result.sheet.layout === "team_sections" ? "자동 인식" : "확인"}${unsafeTestName ? " · 시험용 탭 이름을 ‘플랫폼연결시험’으로 바꿨습니다." : ""}`);
            }
          }}>주소·탭 연결 확인</button>
          <button type="button" className="button secondary" disabled={busy} onClick={async () => { const result = await saveThenSheetAction("create_sheet_tabs", "안전한 연결 시험용 빈 탭을 준비했습니다."); if (result?.sheet) setSheetResult(`새로 만든 탭: ${result.sheet.created.join(", ") || "없음"}`); }}>{String(sheet.mode ?? "existing") === "managed" ? "운영·시험 빈 탭 만들기" : "시험용 빈 탭 만들기"}</button>
          <button type="button" className="button" disabled={busy} onClick={async () => { const result = await saveThenSheetAction("test_sheet", "비식별 연결 시험이 성공했습니다."); if (result?.sheet) setSheetResult(`연결 성공 · ${result.sheet.sheetName}`); }}>시험용 탭 연결 확인</button>
        </div>
        {sheetTabs.length ? <p className="section-subtitle">확인된 탭: {sheetTabs.join(", ")}</p> : null}
        {String(sheet.mode ?? "existing") === "existing" ? <div className="stack"><h3>기존 탭 열 연결</h3>{structured ? <p className="notice-box">이 시트의 기존 양식 구조와 {Number(sheet.headerRow ?? 1)}행 열 제목을 인식했습니다. 팀 이름의 괄호 안 이름과 같은 탭으로 자동 연결하므로 열을 하나씩 지정하지 않아도 됩니다.</p> : <><p className="section-subtitle">열 이름을 플랫폼 항목과 연결합니다. * 표시는 필수입니다.</p><div className="grid two">{mappingFields.map(([key, label]) => <label className="label" key={key}>{label}<select className="select" value={mapping[key] ?? ""} onChange={(event) => setDefinition({ ...definition, sheet: { ...sheet, columnMapping: { ...mapping, [key]: event.target.value } } })}><option value="">연결하지 않음</option>{sheetHeaders.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>{!sheetHeaders.length ? <p className="warning-box">‘주소·탭 연결 확인’을 눌러 열 목록을 불러오세요.</p> : null}</>}</div> : null}
        {sheetResult ? <div className="notice-box">{sheetResult}</div> : null}
      </div>;
    }
    if (editing.configType === "exam") return <div className="stack"><label className="label">시험 이름<input className="input" value={String(definition.title ?? "")} onChange={(event) => setDefinition({ ...definition, title: event.target.value })} /></label><div className="toolbar-group">{[["commonCount", "공통 문항"], ["teamCount", "팀 문항"], ["individualCount", "개인 문항"], ["totalScore", "총점"]].map(([key, label]) => <label className="label" key={key}>{label}<input className="input" type="number" min="0" value={Number(definition[key] ?? 0)} onChange={(event) => setDefinition({ ...definition, [key]: Number(event.target.value) })} /></label>)}</div><label className="label">공통 출제 범위<textarea className="textarea" value={String(definition.commonScope ?? "")} onChange={(event) => setDefinition({ ...definition, commonScope: event.target.value })} /></label><div className="toolbar-group"><label className="label">기본 역량<input className="input" value={String(definition.defaultCompetency ?? "")} onChange={(event) => setDefinition({ ...definition, defaultCompetency: event.target.value })} /></label><label className="label">기본 난이도<select className="select" value={String(definition.defaultDifficulty ?? "standard")} onChange={(event) => setDefinition({ ...definition, defaultDifficulty: event.target.value })}><option value="basic">기초</option><option value="standard">표준</option><option value="advanced">심화</option></select></label></div></div>;
    const items = Array.isArray(definition.items) ? definition.items as Array<{ id: string; prompt: string; levels: Record<string, string> }> : [];
    return <div className="stack">{items.map((item, index) => <article className="discussion-note stack" key={item.id}><label className="label">행동 기준 {index + 1}<input className="input" value={item.prompt} onChange={(event) => { const next = copy(items); next[index].prompt = event.target.value; setDefinition({ ...definition, items: next }); }} /></label><div className="responsive-table"><table><thead><tr><th>단계</th><th>확인할 수 있는 행동</th></tr></thead><tbody>{[1, 2, 3, 4].map((level) => <tr key={level}><td>{level}</td><td><input className="input" value={item.levels[String(level)] ?? ""} onChange={(event) => { const next = copy(items); next[index].levels[String(level)] = event.target.value; setDefinition({ ...definition, items: next }); }} /></td></tr>)}</tbody></table></div>{index >= 4 ? <button type="button" className="button ghost" onClick={() => setDefinition({ ...definition, items: items.filter((_, itemIndex) => itemIndex !== index) })}>선택 문항 삭제</button> : null}</article>)}{items.length < 5 ? <button type="button" className="button secondary" onClick={() => setDefinition({ ...definition, items: [...items, { id: `optional${items.length + 1}`, prompt: "새 선택 문항", levels: { "1": "거의 확인되지 않음", "2": "일부 확인됨", "3": "대체로 확인됨", "4": "구체적인 근거와 함께 확인됨" } }] })}>선택 문항 추가</button> : null}{editing.configType === "self_evaluation" ? <div className="stack"><h3>성찰 질문</h3>{(Array.isArray(definition.selfReflectionQuestions) ? definition.selfReflectionQuestions as string[] : []).map((question, index, all) => <input className="input" key={index} value={question} onChange={(event) => { const next = [...all]; next[index] = event.target.value; setDefinition({ ...definition, selfReflectionQuestions: next }); }} />)}</div> : null}</div>;
  }

  if (!club) return <section className="card card-body"><h2 className="section-heading">동아리 운영 설정</h2><p>먼저 대시보드에서 동아리를 만들어 주세요.</p></section>;
  return <div className="stack">
    {error ? <p className="error-box" role="alert">{error}</p> : null}
    <section className="card card-body stack"><label className="label">설정할 동아리<select className="select" value={club.id} onChange={(event) => { setClubId(event.target.value); setEditing(null); }} >{data.clubs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {data.isMaster ? <details><summary>담당 교사 지정</summary><div className="stack card-body">{data.teachers.map((teacher) => <label key={teacher.id}><input type="checkbox" checked={club.assignedTeacherIds.includes(teacher.id)} disabled={busy} onChange={(event) => void act({ action: "assign_teacher", clubId: club.id, teacherId: teacher.id, assigned: event.target.checked }, "담당 교사 설정을 저장했습니다.")} /> {teacher.name} ({teacher.loginId})</label>)}</div></details> : null}
    </section>
    <section className="card card-body stack"><div><h2 className="section-heading">기본 기능</h2><p className="section-subtitle">발행된 버전은 학생 활동에 고정됩니다. 바꿀 때는 새 초안을 만드세요.</p></div>{BASE_CONFIGS.map((config) => { const versions = latest(club.versions, config.type); const draft = versions.find((version) => version.status === "draft"); const published = versions.find((version) => version.status === "published"); return <article className="discussion-note" key={config.type}><div className="toolbar"><div><h3>{config.label}</h3><p>{config.description}</p><p className="section-subtitle">{published ? `사용 중 v${published.versionNumber} · ${published.title}` : "아직 사용하지 않음"}</p></div><div className="toolbar-group">{draft ? <button className="button" onClick={() => openEditor(draft)}>초안 이어서 편집</button> : <button className="button secondary" disabled={busy} onClick={() => void act({ action: "create_draft", clubId: club.id, configType: config.type, basedOnId: published?.id }, "새 초안을 만들었습니다.")}>{published ? "새 버전 만들기" : "설정 시작"}</button>}</div></div></article>;})}</section>
    <section className="card card-body stack"><div className="toolbar"><div><h2 className="section-heading">동아리 전용 탭</h2><p className="section-subtitle">코딩 없이 항목을 조합해 팀 또는 개인 작성 탭을 추가합니다.</p></div><button className="button" disabled={busy} onClick={() => void act({ action: "create_draft", clubId: club.id, configType: "custom_tab", title: "새 탭" }, "새 탭 초안을 만들었습니다.")}>새 탭 만들기</button></div>{customKeys.map((key) => { const versions = latest(club.versions, "custom_tab", key); const draft = versions.find((version) => version.status === "draft"); const published = versions.find((version) => version.status === "published"); return <article className="discussion-note toolbar" key={key}><div><b>{draft?.title ?? published?.title ?? "새 탭"}</b><p className="section-subtitle">{published ? `사용 중 v${published.versionNumber}` : "발행 전"}</p></div>{draft ? <button className="button" onClick={() => openEditor(draft)}>편집</button> : <button className="button secondary" disabled={busy} onClick={() => void act({ action: "create_draft", clubId: club.id, configType: "custom_tab", basedOnId: published?.id }, "새 버전 초안을 만들었습니다.")}>새 버전</button>}</article>;})}</section>
    <section className="card card-body stack"><div><h2 className="section-heading">전용 탭 제출 검토</h2><p className="section-subtitle">‘교사 검토 포함’으로 만든 탭의 학생 제출물과 피드백을 관리합니다.</p></div>{club.customResponses.length ? club.customResponses.map((response) => <article className="discussion-note stack" key={response.id}><div className="toolbar"><div><b>{response.tabTitle} · {response.teamName}{response.studentName ? ` · ${response.studentName}` : ""}</b><p className="section-subtitle">{response.status === "reviewed" ? "검토 완료" : response.status === "feedback" ? "피드백 저장" : "새 제출"}</p></div><span className={`badge ${response.status === "reviewed" ? "approved" : "pending"}`}>{response.responseMode === "individual" ? "개인" : "팀"}</span></div><dl>{Object.entries(response.responseData).map(([key, value]) => <div key={key}><dt><b>{responseFieldLabel(club.versions, response.configVersionId, key)}</b></dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl><label className="label">학생에게 보낼 피드백<textarea className="textarea" maxLength={2000} value={feedbacks[response.id] ?? response.teacherFeedback} onChange={(event) => setFeedbacks((current) => ({ ...current, [response.id]: event.target.value }))} /></label><div className="toolbar-group"><button className="button secondary" disabled={busy} onClick={() => void act({ action: "review_custom_response", responseId: response.id, expectedVersion: response.version, teacherFeedback: feedbacks[response.id] ?? response.teacherFeedback, reviewed: false }, "피드백을 저장했습니다.")}>피드백 저장</button><button className="button" disabled={busy} onClick={() => void act({ action: "review_custom_response", responseId: response.id, expectedVersion: response.version, teacherFeedback: feedbacks[response.id] ?? response.teacherFeedback, reviewed: true }, "검토를 완료했습니다.")}>검토 완료</button></div></article>) : <div className="empty-state">검토할 제출물이 없습니다.</div>}</section>
    {editing ? <section className="card card-body stack"><div className="toolbar"><div><h2 className="section-heading">{editing.status === "draft" ? "초안 편집" : "설정 보기"}</h2><p className="section-subtitle">v{editing.versionNumber} · 저장 중 다른 교사의 변경이 있으면 알려드립니다.</p></div><button className="button ghost" onClick={() => setEditing(null)}>닫기</button></div><label className="label">이름<input className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></label>{renderDefinition()}<div className="toolbar-group"><button className="button secondary" disabled={busy} onClick={() => void save()}>초안 저장</button><label className="label">발행 확인: {club.name}<input className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button className="button" disabled={busy || confirmation !== club.name} onClick={async () => { if (await act({ action: "publish", versionId: editing.id, confirmation }, "새 설정을 발행했습니다.")) setEditing(null); }}>저장된 초안 발행</button><button className="button ghost" disabled={busy} onClick={async () => { if (window.confirm("이 초안을 보관할까요?")) { if (await act({ action: "archive", versionId: editing.id }, "초안을 보관했습니다.")) setEditing(null); } }}>초안 보관</button></div></section> : null}
  </div>;
}
