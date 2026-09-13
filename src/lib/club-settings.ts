import { ACADEMIC_YEAR, PLAN_FIELDS, REPORT_FIELDS } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { CORE_EVALUATION_ITEMS } from "@/lib/evaluation-service";
import { createId } from "@/lib/id";
import { createGoogleSheetTabs, detectGoogleMaterialSheetLayout, ensureManagedMaterialHeaders, inspectGoogleSpreadsheet, testGoogleSheetConnection } from "@/lib/google-sheets";
import { UserFacingError } from "@/lib/user-facing-error";

export const CLUB_CONFIG_TYPES = ["plan", "report", "materials", "self_evaluation", "peer_evaluation", "exam", "custom_tab"] as const;
export type ClubConfigType = typeof CLUB_CONFIG_TYPES[number];
export type ConfigStatus = "draft" | "published" | "archived";
export type FormFieldKind = "heading" | "short_text" | "long_text" | "number" | "date" | "single_choice" | "multiple_choice" | "checkbox" | "table";

export type FormFieldDefinition = {
  id: string;
  label: string;
  kind: FormFieldKind;
  required?: boolean;
  help?: string;
  options?: string[];
  columns?: Array<{ id: string; label: string; kind: "short_text" | "number" | "date" }>;
};

export type ClubConfigVersion = {
  id: string;
  clubId: string;
  configType: ClubConfigType;
  configKey: string;
  versionNumber: number;
  title: string;
  status: ConfigStatus;
  definition: Record<string, unknown>;
  basedOnId: string | null;
  revision: number;
  createdByName: string;
  publishedByName: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type ClubSettingsData = {
  isMaster: boolean;
  teachers: Array<{ id: string; name: string; loginId: string }>;
  clubs: Array<{
    id: string;
    name: string;
    canManage: boolean;
    assignedTeacherIds: string[];
    versions: ClubConfigVersion[];
    customResponses: Array<{
      id: string;
      version: number;
      configVersionId: string;
      tabTitle: string;
      responseMode: "team" | "individual";
      teamName: string;
      studentName: string | null;
      responseData: Record<string, unknown>;
      status: "submitted" | "feedback" | "reviewed";
      teacherFeedback: string;
      submittedAt: string | null;
    }>;
  }>;
};

const CONFIG_TITLES: Record<Exclude<ClubConfigType, "custom_tab">, string> = {
  plan: "탐구 계획서",
  report: "최종보고서",
  materials: "준비물 Google Sheet",
  self_evaluation: "자기평가",
  peer_evaluation: "동료평가",
  exam: "시험 기본안",
};

function planFields(): FormFieldDefinition[] {
  return PLAN_FIELDS.map((field) => field.kind === "schedule" ? {
    id: field.key, label: field.label, kind: "table", required: false,
    columns: [
      { id: "period", label: "수행기간", kind: "short_text" },
      { id: "location", label: "장소", kind: "short_text" },
      { id: "content", label: "탐구내용", kind: "short_text" },
      { id: "materials", label: "준비물", kind: "short_text" },
    ],
  } : {
    id: field.key,
    label: field.label,
    kind: field.kind === "select" ? "single_choice" : field.kind === "text" ? "short_text" : "long_text",
    required: ["field", "topic", "motivation", "purpose", "method", "expectedResult"].includes(field.key),
    ...(field.key === "field" ? { options: ["물리", "화학", "식물", "동물", "지구과학", "농림수산", "공학", "에너지", "환경", "발명", "빅데이터", "기타"] } : {}),
  } as FormFieldDefinition);
}

function reportFields(): FormFieldDefinition[] {
  return [{ id: "title", label: "연구주제", kind: "short_text", required: true }, ...REPORT_FIELDS.map((field) => ({
    id: field.key, label: field.label, kind: "long_text" as const, required: field.key !== "appendix",
  }))];
}

export function defaultClubConfigDefinition(configType: ClubConfigType): Record<string, unknown> {
  if (configType === "plan") return { description: "동아리 팀이 함께 작성하는 탐구 계획서입니다.", fields: planFields() };
  if (configType === "report") return { description: "동아리 팀이 함께 작성하는 최종보고서입니다.", fields: reportFields() };
  if (configType === "materials") return {
    fields: [
      { id: "name", label: "품명", kind: "short_text", required: true },
      { id: "specification", label: "규격(선택옵션)", kind: "short_text" },
      { id: "unitPrice", label: "단가", kind: "number", required: true },
      { id: "quantity", label: "개수", kind: "number", required: true },
      { id: "shipping", label: "배송비", kind: "number" },
      { id: "link", label: "링크", kind: "short_text", required: true },
    ],
    sheet: { mode: "existing", spreadsheetUrl: "", sheetName: "", testSheetName: "", columnMapping: {} },
  };
  if (configType === "self_evaluation" || configType === "peer_evaluation") return {
    items: CORE_EVALUATION_ITEMS,
    selfReflectionQuestions: [
      "이번 탐구에서 내가 실제로 한 가장 중요한 일 한 가지와 확인할 수 있는 근거는 무엇인가?",
      "다음 탐구에서 바꾸거나 더 잘하고 싶은 행동 한 가지는 무엇인가?",
    ],
  };
  if (configType === "exam") return {
    title: "동아리 탐구 수행평가",
    commonCount: 4,
    teamCount: 2,
    individualCount: 1,
    totalScore: 100,
    commonScope: "자료 해석, 변인 통제, 증거와 결론 연결, 오차 분석, 실험 개선",
    defaultCompetency: "과학적 탐구 역량",
    defaultDifficulty: "standard",
  };
  return { description: "", responseMode: "team", workflow: "save", useForExam: false, fields: [] };
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalizeFields(value: unknown) {
  if (!Array.isArray(value) || value.length > 40) throw new UserFacingError("양식 항목은 최대 40개까지 만들 수 있습니다.");
  const ids = new Set<string>();
  return value.map((raw) => {
    const field = raw as Partial<FormFieldDefinition>;
    const id = String(field.id ?? "").trim();
    const label = String(field.label ?? "").trim();
    const kinds: FormFieldKind[] = ["heading", "short_text", "long_text", "number", "date", "single_choice", "multiple_choice", "checkbox", "table"];
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,59}$/.test(id) || ids.has(id)) throw new UserFacingError("각 항목의 식별자는 영문으로 시작하며 서로 달라야 합니다.");
    if (!label || label.length > 120 || !kinds.includes(field.kind as FormFieldKind)) throw new UserFacingError("양식 항목의 이름과 종류를 확인해 주세요.");
    ids.add(id);
    const normalized: FormFieldDefinition = { id, label, kind: field.kind as FormFieldKind, required: Boolean(field.required), help: String(field.help ?? "").slice(0, 500) };
    if (normalized.kind === "single_choice" || normalized.kind === "multiple_choice") {
      const options = Array.isArray(field.options) ? field.options.map((item) => String(item).trim()).filter(Boolean).slice(0, 30) : [];
      if (options.length < 1) throw new UserFacingError(`${label} 항목에 선택지를 한 개 이상 입력해 주세요.`);
      normalized.options = options;
    }
    if (normalized.kind === "table") {
      const columns = Array.isArray(field.columns) ? field.columns.slice(0, 12).map((column) => ({
        id: String(column.id ?? "").trim(), label: String(column.label ?? "").trim(), kind: column.kind === "number" || column.kind === "date" ? column.kind : "short_text" as const,
      })) : [];
      if (!columns.length || columns.some((column) => !/^[A-Za-z][A-Za-z0-9_-]{1,59}$/.test(column.id) || !column.label)) throw new UserFacingError(`${label} 표의 열을 확인해 주세요.`);
      normalized.columns = columns;
    }
    return normalized;
  });
}

function normalizeDefinition(configType: ClubConfigType, definition: Record<string, unknown>) {
  if (configType === "plan" || configType === "report" || configType === "custom_tab") {
    const fields = normalizeFields(definition.fields);
    if ((configType === "plan" || configType === "report") && !fields.length) throw new UserFacingError("계획서와 보고서에는 항목이 한 개 이상 필요합니다.");
    const responseMode = definition.responseMode === "individual" ? "individual" : "team";
    const workflow = definition.workflow === "review" ? "review" : "save";
    return { description: String(definition.description ?? "").trim().slice(0, 1000), fields, ...(configType === "custom_tab" ? { responseMode, workflow, useForExam: Boolean(definition.useForExam) } : {}) };
  }
  if (configType === "materials") {
    const fields = normalizeFields(definition.fields);
    const sheet = (definition.sheet ?? {}) as Record<string, unknown>;
    const mode = sheet.mode === "managed" ? "managed" : "existing";
    const spreadsheetUrl = String(sheet.spreadsheetUrl ?? "").trim();
    const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(spreadsheetUrl);
    if (!match) throw new UserFacingError("Google Sheet 주소를 확인해 주세요.");
    const sheetNames = [...new Set((Array.isArray(sheet.sheetNames) ? sheet.sheetNames : String(sheet.sheetName ?? "").split(","))
      .map((value) => String(value).trim()).filter(Boolean))].slice(0, 30);
    const sheetName = sheetNames.join(", ");
    const testSheetName = String(sheet.testSheetName ?? "").trim();
    if (!sheetName || !testSheetName || sheetName.length > 100 || testSheetName.length > 100) throw new UserFacingError("운영 탭과 연결 시험용 탭 이름을 입력해 주세요.");
    const rawMapping = typeof sheet.columnMapping === "object" && sheet.columnMapping ? sheet.columnMapping as Record<string, unknown> : {};
    const allowedMappingKeys = new Set(["submittedAt", "teamName", "leaderLoginId", "leaderName", "name", "specification", "unitPrice", "quantity", "shipping", "total", "link"]);
    const columnMapping = Object.fromEntries(Object.entries(rawMapping)
      .filter(([key, value]) => allowedMappingKeys.has(key) && typeof value === "string" && value.trim())
      .map(([key, value]) => [key, String(value).trim().slice(0, 120)]));
    const mappedHeaders = Object.values(columnMapping);
    if (new Set(mappedHeaders).size !== mappedHeaders.length) throw new UserFacingError("하나의 Google Sheet 열에는 한 항목만 연결해 주세요.");
    const layout = sheet.layout === "team_sections" ? "team_sections" : "header_row";
    const headerRow = Number.isInteger(Number(sheet.headerRow)) ? Math.min(20, Math.max(1, Number(sheet.headerRow))) : 1;
    return { fields, sheet: { mode, spreadsheetUrl, spreadsheetId: match[1], sheetName, sheetNames, testSheetName, columnMapping, layout, headerRow } };
  }
  if (configType === "self_evaluation" || configType === "peer_evaluation") {
    const items = Array.isArray(definition.items) ? definition.items : [];
    if (items.length < 4 || items.length > 5) throw new UserFacingError("평가 문항은 핵심 4개와 선택 문항 최대 1개로 구성해 주세요.");
    const normalized = items.map((raw, index) => {
      const item = raw as { id?: unknown; prompt?: unknown; levels?: Record<string, unknown> };
      const id = String(item.id ?? `item_${index + 1}`).trim();
      const prompt = String(item.prompt ?? "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,59}$/.test(id) || !prompt || prompt.length > 160) throw new UserFacingError("평가 문항 이름을 확인해 주세요.");
      const levels = Object.fromEntries(["1", "2", "3", "4"].map((level) => [level, String(item.levels?.[level] ?? "").trim()]));
      if (Object.values(levels).some((text) => !text || text.length > 500)) throw new UserFacingError("각 평가 문항의 1~4단계 행동 기준을 모두 입력해 주세요.");
      return { id, prompt, levels };
    });
    if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new UserFacingError("평가 문항 식별자가 중복되었습니다.");
    const reflections = Array.isArray(definition.selfReflectionQuestions) ? definition.selfReflectionQuestions.map((item) => String(item).trim()).slice(0, 2) : [];
    return { items: normalized, selfReflectionQuestions: reflections.length === 2 && reflections.every(Boolean) ? reflections : defaultClubConfigDefinition("self_evaluation").selfReflectionQuestions };
  }
  const commonCount = Number(definition.commonCount);
  const teamCount = Number(definition.teamCount);
  const individualCount = Number(definition.individualCount);
  const totalScore = Number(definition.totalScore);
  if (![commonCount, teamCount, individualCount, totalScore].every(Number.isInteger) || commonCount < 0 || commonCount > 5 || teamCount < 0 || teamCount > 5 || individualCount < 0 || individualCount > 3 || commonCount + teamCount + individualCount < 1 || commonCount + teamCount + individualCount > 10 || totalScore < 1 || totalScore > 200) throw new UserFacingError("시험 문항 수와 총점을 확인해 주세요.");
  const title = String(definition.title ?? "").trim().slice(0, 100);
  if (!title) throw new UserFacingError("시험 이름을 입력해 주세요.");
  return {
    title, commonCount, teamCount, individualCount, totalScore,
    commonScope: String(definition.commonScope ?? "").trim().slice(0, 1000),
    defaultCompetency: String(definition.defaultCompetency ?? "").trim().slice(0, 100),
    defaultDifficulty: ["basic", "standard", "advanced"].includes(String(definition.defaultDifficulty)) ? definition.defaultDifficulty : "standard",
  };
}

async function actorRow(actorId: string) {
  const db = await getDb();
  const result = await db.query<{ is_master: boolean }>("SELECT is_master FROM users WHERE id = $1 AND role = 'teacher' AND status = 'active' AND must_change_password = FALSE AND academic_year = $2", [actorId, ACADEMIC_YEAR]);
  if (!result.rows[0]) throw new UserFacingError("교사 권한이 필요합니다.");
  return result.rows[0];
}

export async function assertClubSettingsAccess(actorId: string, clubId: string) {
  const actor = await actorRow(actorId);
  const db = await getDb();
  const club = await db.query("SELECT id FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR]);
  if (!club.rows.length) throw new UserFacingError("현재 학년도의 동아리 설정만 변경할 수 있습니다.");
  if (actor.is_master) return;
  const assigned = await db.query("SELECT 1 FROM club_teacher_assignments WHERE club_id = $1 AND teacher_id = $2", [clubId, actorId]);
  if (!assigned.rows[0]) throw new UserFacingError("이 동아리의 운영 설정 권한이 없습니다.");
}

export async function getClubSettingsData(actorId: string): Promise<ClubSettingsData> {
  const actor = await actorRow(actorId);
  const db = await getDb();
  const clubQuery = actor.is_master
    ? db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE academic_year = $1 ORDER BY name", [ACADEMIC_YEAR])
    : db.query<{ id: string; name: string }>(`SELECT c.id, c.name FROM clubs c JOIN club_teacher_assignments a ON a.club_id = c.id
        WHERE c.academic_year = $1 AND a.teacher_id = $2 ORDER BY c.name`, [ACADEMIC_YEAR, actorId]);
  const versionQuery = actor.is_master
    ? db.query<{
      id: string; club_id: string; config_type: ClubConfigType; config_key: string; version_number: number; title: string;
      status: ConfigStatus; definition: Record<string, unknown> | string; based_on_id: string | null; revision: number;
      created_by_name: string; published_by_name: string | null; published_at: Date | string | null; updated_at: Date | string;
    }>(`SELECT v.id, v.club_id, v.config_type, v.config_key, v.version_number, v.title, v.status, v.definition,
              v.based_on_id, v.revision, creator.name AS created_by_name, publisher.name AS published_by_name,
              v.published_at, v.updated_at
         FROM club_config_versions v JOIN users creator ON creator.id = v.created_by
         LEFT JOIN users publisher ON publisher.id = v.published_by
         JOIN clubs c ON c.id = v.club_id WHERE c.academic_year = $1
        ORDER BY v.club_id, v.config_type, v.config_key, v.version_number DESC`, [ACADEMIC_YEAR])
    : db.query<{
      id: string; club_id: string; config_type: ClubConfigType; config_key: string; version_number: number; title: string;
      status: ConfigStatus; definition: Record<string, unknown> | string; based_on_id: string | null; revision: number;
      created_by_name: string; published_by_name: string | null; published_at: Date | string | null; updated_at: Date | string;
    }>(`SELECT v.id, v.club_id, v.config_type, v.config_key, v.version_number, v.title, v.status, v.definition,
              v.based_on_id, v.revision, creator.name AS created_by_name, publisher.name AS published_by_name,
              v.published_at, v.updated_at
         FROM club_config_versions v JOIN users creator ON creator.id = v.created_by
         LEFT JOIN users publisher ON publisher.id = v.published_by
         JOIN clubs c ON c.id = v.club_id JOIN club_teacher_assignments a ON a.club_id = v.club_id
        WHERE c.academic_year = $1 AND a.teacher_id = $2
        ORDER BY v.club_id, v.config_type, v.config_key, v.version_number DESC`, [ACADEMIC_YEAR, actorId]);
  const [clubs, teachers, assignments, versions, customResponses] = await Promise.all([
    clubQuery,
    db.query<{ id: string; name: string; login_id: string }>("SELECT id, name, login_id FROM users WHERE academic_year = $1 AND role = 'teacher' AND status = 'active' ORDER BY name, login_id", [ACADEMIC_YEAR]),
    db.query<{ club_id: string; teacher_id: string }>("SELECT club_id, teacher_id FROM club_teacher_assignments"),
    versionQuery,
    db.query<{
      id: string; club_id: string; config_version_id: string; tab_title: string; definition: Record<string, unknown> | string;
      team_name: string; student_name: string | null; response_data: Record<string, unknown> | string;
      status: "submitted" | "feedback" | "reviewed"; teacher_feedback: string | null; submitted_at: Date | string | null; write_version: number;
    }>(`SELECT r.id, v.club_id, r.config_version_id, v.title AS tab_title, v.definition,
              t.name AS team_name, student.name AS student_name, r.response_data, r.status,
              r.teacher_feedback, r.submitted_at, r.write_version
         FROM club_custom_responses r
         JOIN club_config_versions v ON v.id = r.config_version_id
         JOIN inquiry_sessions s ON s.id = r.session_id
         JOIN teams t ON t.id = s.team_id
         LEFT JOIN users student ON student.id = r.student_id
        WHERE r.status IN ('submitted', 'feedback', 'reviewed')
        ORDER BY r.submitted_at DESC NULLS LAST, r.updated_at DESC`),
  ]);
  return {
    isMaster: actor.is_master,
    teachers: teachers.rows.map((teacher) => ({ id: teacher.id, name: teacher.name, loginId: teacher.login_id })),
    clubs: clubs.rows.map((club) => ({
      id: club.id,
      name: club.name,
      canManage: true,
      assignedTeacherIds: assignments.rows.filter((item) => item.club_id === club.id).map((item) => item.teacher_id),
      versions: versions.rows.filter((version) => version.club_id === club.id).map((version) => ({
        id: version.id, clubId: version.club_id, configType: version.config_type, configKey: version.config_key,
        versionNumber: version.version_number, title: version.title, status: version.status,
        definition: parseJson(version.definition, {}), basedOnId: version.based_on_id, revision: version.revision,
        createdByName: version.created_by_name, publishedByName: version.published_by_name,
        publishedAt: version.published_at ? new Date(version.published_at).toISOString() : null,
        updatedAt: new Date(version.updated_at).toISOString(),
      })),
      customResponses: customResponses.rows.filter((response) => response.club_id === club.id).map((response) => {
        const definition = parseJson(response.definition, {}) as { responseMode?: "team" | "individual" };
        return {
          id: response.id,
          version: response.write_version,
          configVersionId: response.config_version_id,
          tabTitle: response.tab_title,
          responseMode: definition.responseMode === "individual" ? "individual" : "team",
          teamName: response.team_name,
          studentName: response.student_name,
          responseData: parseJson(response.response_data, {}),
          status: response.status,
          teacherFeedback: response.teacher_feedback ?? "",
          submittedAt: response.submitted_at ? new Date(response.submitted_at).toISOString() : null,
        };
      }),
    })),
  };
}

export async function setClubTeacherAssignment(actorId: string, clubId: string, teacherId: string, assigned: boolean) {
  const actor = await actorRow(actorId);
  if (!actor.is_master) throw new UserFacingError("마스터 관리자만 동아리 담당 교사를 지정할 수 있습니다.");
  const db = await getDb();
  const valid = await db.query("SELECT 1 FROM clubs c, users u WHERE c.id = $1 AND c.academic_year = $3 AND u.id = $2 AND u.role = 'teacher' AND u.status = 'active'", [clubId, teacherId, ACADEMIC_YEAR]);
  if (!valid.rows[0]) throw new UserFacingError("동아리와 교사 계정을 확인해 주세요.");
  if (assigned) await db.query("INSERT INTO club_teacher_assignments (club_id, teacher_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT (club_id, teacher_id) DO NOTHING", [clubId, teacherId, actorId]);
  else await db.query("DELETE FROM club_teacher_assignments WHERE club_id = $1 AND teacher_id = $2", [clubId, teacherId]);
  await audit(actorId, assigned ? "club_teacher_assigned" : "club_teacher_unassigned", "club", clubId, { teacherId });
}

export async function createClubConfigDraft(actorId: string, input: { clubId: string; configType: ClubConfigType; title?: string; basedOnId?: string }) {
  await assertClubSettingsAccess(actorId, input.clubId);
  const db = await getDb();
  let base: { id: string; config_key: string; title: string; definition: Record<string, unknown> | string } | undefined;
  if (input.basedOnId) {
    const result = await db.query<typeof base & {}>("SELECT id, config_key, title, definition FROM club_config_versions WHERE id = $1 AND club_id = $2 AND config_type = $3", [input.basedOnId, input.clubId, input.configType]);
    base = result.rows[0] as typeof base;
  }
  const configKey = input.configType === "custom_tab" ? base?.config_key ?? createId("tab") : "default";
  const existingDraft = await db.query<{ id: string }>("SELECT id FROM club_config_versions WHERE club_id = $1 AND config_type = $2 AND config_key = $3 AND status = 'draft'", [input.clubId, input.configType, configKey]);
  if (existingDraft.rows[0]) return existingDraft.rows[0].id;
  if (!base) {
    const result = await db.query<{ id: string; config_key: string; title: string; definition: Record<string, unknown> | string }>("SELECT id, config_key, title, definition FROM club_config_versions WHERE club_id = $1 AND config_type = $2 AND config_key = $3 AND status = 'published' ORDER BY version_number DESC LIMIT 1", [input.clubId, input.configType, configKey]);
    base = result.rows[0];
  }
  const max = await db.query<{ value: number }>("SELECT COALESCE(MAX(version_number), 0) AS value FROM club_config_versions WHERE club_id = $1 AND config_type = $2 AND config_key = $3", [input.clubId, input.configType, configKey]);
  const id = createId("club_config");
  const title = String(input.title ?? base?.title ?? (input.configType === "custom_tab" ? "새 탭" : CONFIG_TITLES[input.configType])).trim().slice(0, 100);
  await db.query(`INSERT INTO club_config_versions (id, club_id, config_type, config_key, version_number, title, definition, based_on_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, input.clubId, input.configType, configKey, Number(max.rows[0]?.value ?? 0) + 1, title, JSON.stringify(base ? parseJson(base.definition, {}) : defaultClubConfigDefinition(input.configType)), base?.id ?? null, actorId]);
  await audit(actorId, "club_config_draft_created", "club_config_version", id, { clubId: input.clubId, configType: input.configType, configKey });
  return id;
}

export async function updateClubConfigDraft(actorId: string, input: { versionId: string; title: string; definition: Record<string, unknown>; expectedRevision: number }) {
  const db = await getDb();
  const row = await db.query<{ club_id: string; config_type: ClubConfigType; status: ConfigStatus }>("SELECT club_id, config_type, status FROM club_config_versions WHERE id = $1", [input.versionId]);
  const version = row.rows[0];
  if (!version) throw new UserFacingError("설정 초안을 찾을 수 없습니다.");
  await assertClubSettingsAccess(actorId, version.club_id);
  if (version.status !== "draft") throw new UserFacingError("발행되거나 보관된 버전은 수정할 수 없습니다.");
  const title = input.title.trim();
  if (!title || title.length > 100) throw new UserFacingError("설정 이름을 1~100자로 입력해 주세요.");
  const definition = normalizeDefinition(version.config_type, input.definition);
  const updated = await db.query("UPDATE club_config_versions SET title = $1, definition = $2, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = 'draft' AND revision = $4", [title, JSON.stringify(definition), input.versionId, input.expectedRevision]);
  if (updated.rowCount !== 1) throw new UserFacingError("다른 교사가 먼저 수정했습니다. 최신 내용을 다시 불러와 주세요.");
  await audit(actorId, "club_config_draft_updated", "club_config_version", input.versionId, { clubId: version.club_id, configType: version.config_type });
}

export async function publishClubConfig(actorId: string, versionId: string, confirmation: string) {
  const db = await getDb(); const client = await db.connect();
  let detail: { clubId: string; configType: ClubConfigType; configKey: string; versionNumber: number } | null = null;
  try {
    await client.query("BEGIN");
    const target = await client.query<{ club_id: string }>("SELECT club_id FROM club_config_versions WHERE id = $1", [versionId]);
    if (!target.rows[0]) throw new UserFacingError("설정 초안을 찾을 수 없습니다.");
    // Team creation and exam writes lock the club before version references.
    // Taking a version first can deadlock a repeated publication with an exam FK.
    await client.query("SELECT id FROM clubs WHERE id = $1 FOR UPDATE", [target.rows[0].club_id]);
    const result = await client.query<{ club_id: string; club_name: string; config_type: ClubConfigType; config_key: string; version_number: number; status: ConfigStatus; definition: Record<string, unknown> | string }>(`SELECT v.club_id, c.name AS club_name, v.config_type, v.config_key, v.version_number, v.status, v.definition FROM club_config_versions v JOIN clubs c ON c.id = v.club_id WHERE v.id = $1 FOR UPDATE`, [versionId]);
    const version = result.rows[0];
    if (!version) throw new UserFacingError("설정 초안을 찾을 수 없습니다.");
    await assertClubSettingsAccess(actorId, version.club_id);
    if (version.status !== "draft") throw new UserFacingError("초안만 발행할 수 있습니다.");
    if (confirmation.trim() !== version.club_name) throw new UserFacingError(`발행하려면 '${version.club_name}'을(를) 정확히 입력해 주세요.`);
    const normalized = normalizeDefinition(version.config_type, parseJson(version.definition, {}));
    if (version.config_type === "materials") {
      const sheet = normalized.sheet as { mode: string; sheetNames: string[]; testSheetName: string; layout: string; columnMapping: Record<string, string> };
      if (sheet.testSheetName === "양식" || sheet.sheetNames.includes(sheet.testSheetName)) {
        throw new UserFacingError("연결 시험용 탭은 '양식'이나 운영 탭이 아닌 별도의 빈 탭으로 지정해 주세요.");
      }
      if (sheet.mode === "existing" && sheet.layout !== "team_sections" && !["name", "unitPrice", "quantity", "link"].every((key) => sheet.columnMapping[key])) {
        throw new UserFacingError("기존 탭 연결은 품명·단가·개수·링크 열을 각각 지정해 주세요.");
      }
    }
    await client.query("UPDATE club_config_versions SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE club_id = $1 AND config_type = $2 AND config_key = $3 AND status = 'published'", [version.club_id, version.config_type, version.config_key]);
    await client.query("UPDATE club_config_versions SET definition = $1, status = 'published', published_by = $2, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3", [JSON.stringify(normalized), actorId, versionId]);
    await client.query("COMMIT");
    detail = { clubId: version.club_id, configType: version.config_type, configKey: version.config_key, versionNumber: version.version_number };
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
  await audit(actorId, "club_config_published", "club_config_version", versionId, detail ?? {});
}

export async function archiveClubConfig(actorId: string, versionId: string) {
  const db = await getDb();
  const row = await db.query<{ club_id: string; config_type: ClubConfigType; status: ConfigStatus }>("SELECT club_id, config_type, status FROM club_config_versions WHERE id = $1", [versionId]);
  const version = row.rows[0];
  if (!version) throw new UserFacingError("설정을 찾을 수 없습니다.");
  await assertClubSettingsAccess(actorId, version.club_id);
  if (version.status === "archived") throw new UserFacingError("이미 보관된 설정입니다.");
  await db.query("UPDATE club_config_versions SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [versionId]);
  await audit(actorId, "club_config_archived", "club_config_version", versionId, { clubId: version.club_id, configType: version.config_type });
}

export async function getPublishedClubConfig(clubId: string, configType: ClubConfigType, configKey = "default") {
  const db = await getDb();
  const result = await db.query<{ id: string; title: string; definition: Record<string, unknown> | string }>("SELECT id, title, definition FROM club_config_versions WHERE club_id = $1 AND config_type = $2 AND config_key = $3 AND status = 'published' ORDER BY version_number DESC LIMIT 1", [clubId, configType, configKey]);
  const row = result.rows[0];
  return row ? { id: row.id, title: row.title, definition: parseJson(row.definition, {}) } : null;
}

async function sheetDraft(actorId: string, versionId: string) {
  const db = await getDb();
  const result = await db.query<{ club_id: string; config_type: ClubConfigType; status: ConfigStatus; definition: Record<string, unknown> | string }>("SELECT club_id, config_type, status, definition FROM club_config_versions WHERE id = $1", [versionId]);
  const version = result.rows[0];
  if (!version || version.config_type !== "materials") throw new UserFacingError("준비물 설정 초안을 찾을 수 없습니다.");
  await assertClubSettingsAccess(actorId, version.club_id);
  if (version.status !== "draft") throw new UserFacingError("Google Sheet 연결 시험은 발행 전 초안에서 진행해 주세요.");
  const normalized = normalizeDefinition("materials", parseJson(version.definition, {}));
  return { clubId: version.club_id, sheet: normalized.sheet as { mode: "existing" | "managed"; spreadsheetId: string; sheetName: string; sheetNames: string[]; testSheetName: string; columnMapping: Record<string, string>; layout: "header_row" | "team_sections"; headerRow: number } };
}

export async function inspectClubGoogleSheet(actorId: string, versionId: string) {
  const config = await sheetDraft(actorId, versionId);
  const tabs = await inspectGoogleSpreadsheet(config.sheet.spreadsheetId);
  const tabNames = new Set(tabs.map((tab) => tab.title));
  const missingOperatingTabs = config.sheet.sheetNames.filter((name) => !tabNames.has(name));
  const firstOperatingTab = config.sheet.sheetNames.find((name) => tabNames.has(name));
  const detected = firstOperatingTab
    ? await detectGoogleMaterialSheetLayout(config.sheet.spreadsheetId, firstOperatingTab)
    : { headers: [] as string[], headerRow: 1, layout: "header_row" as const };
  await audit(actorId, "club_sheet_inspected", "club_config_version", versionId, { clubId: config.clubId });
  return {
    tabs: tabs.map((tab) => tab.title), headers: detected.headers, headerRow: detected.headerRow, layout: detected.layout,
    operatingTabFound: config.sheet.sheetNames.length > 0 && missingOperatingTabs.length === 0,
    missingOperatingTabs, testTabFound: tabNames.has(config.sheet.testSheetName),
  };
}

export async function createClubGoogleSheetTabs(actorId: string, versionId: string) {
  const config = await sheetDraft(actorId, versionId);
  if (config.sheet.testSheetName === "양식" || config.sheet.sheetNames.includes(config.sheet.testSheetName)) {
    throw new UserFacingError("연결 시험용 탭은 '양식'이나 운영 탭이 아닌 새 이름으로 입력해 주세요.");
  }
  const names = config.sheet.mode === "managed" ? [config.sheet.testSheetName, config.sheet.sheetNames[0]] : [config.sheet.testSheetName];
  const result = await createGoogleSheetTabs(config.sheet.spreadsheetId, names);
  if (config.sheet.mode === "managed") await ensureManagedMaterialHeaders(config.sheet.spreadsheetId, config.sheet.sheetNames[0]);
  await audit(actorId, "club_sheet_tabs_created", "club_config_version", versionId, { clubId: config.clubId, ...result });
  return result;
}

export async function testClubGoogleSheet(actorId: string, versionId: string) {
  const config = await sheetDraft(actorId, versionId);
  if (config.sheet.testSheetName === "양식" || config.sheet.sheetNames.includes(config.sheet.testSheetName)) {
    throw new UserFacingError("연결 시험용 탭은 '양식'이나 운영 탭이 아닌 별도의 빈 탭으로 지정해 주세요.");
  }
  const result = await testGoogleSheetConnection(config.sheet.spreadsheetId, config.sheet.testSheetName);
  await audit(actorId, "club_sheet_connection_tested", "club_config_version", versionId, { clubId: config.clubId, ...result });
  return result;
}
