import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { getCurrentUser } from "@/lib/auth";
import {
  CLUB_CONFIG_TYPES,
  archiveClubConfig,
  createClubConfigDraft,
  getClubSettingsData,
  inspectClubGoogleSheet,
  publishClubConfig,
  createClubGoogleSheetTabs,
  setClubTeacherAssignment,
  updateClubConfigDraft,
  testClubGoogleSheet,
} from "@/lib/club-settings";
import { reviewCustomTabResponse } from "@/lib/club-custom-tabs";
import { userFacingMessage } from "@/lib/user-facing-error";

const configType = z.enum(CLUB_CONFIG_TYPES);
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_draft"),
    clubId: z.string().min(1),
    configType,
    title: z.string().max(100).optional(),
    basedOnId: z.string().optional(),
  }),
  z.object({ action: z.literal("inspect_sheet"), versionId: z.string().min(1) }),
  z.object({ action: z.literal("create_sheet_tabs"), versionId: z.string().min(1) }),
  z.object({ action: z.literal("test_sheet"), versionId: z.string().min(1) }),
  z.object({ action: z.literal("review_custom_response"), responseId: z.string().min(1), teacherFeedback: z.string().max(2_000), reviewed: z.boolean(), expectedVersion: z.number().int().nonnegative() }),
  z.object({
    action: z.literal("update_draft"),
    versionId: z.string().min(1),
    title: z.string().min(1).max(100),
    definition: z.record(z.string(), z.unknown()),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({ action: z.literal("publish"), versionId: z.string().min(1), confirmation: z.string() }),
  z.object({ action: z.literal("archive"), versionId: z.string().min(1) }),
  z.object({
    action: z.literal("assign_teacher"),
    clubId: z.string().min(1),
    teacherId: z.string().min(1),
    assigned: z.boolean(),
  }),
]);

async function teacher() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "teacher" || actor.mustChangePassword) return null;
  return actor;
}

export async function GET() {
  const actor = await teacher();
  if (!actor) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  try {
    return Response.json(await getClubSettingsData(actor.id));
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const actor = await teacher();
  if (!actor) return Response.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "입력 내용을 확인해 주세요." }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "create_draft") {
      const versionId = await createClubConfigDraft(actor.id, input);
      return Response.json({ ok: true, versionId });
    }
    if (input.action === "update_draft") await updateClubConfigDraft(actor.id, input);
    if (input.action === "publish") await publishClubConfig(actor.id, input.versionId, input.confirmation);
    if (input.action === "archive") await archiveClubConfig(actor.id, input.versionId);
    if (input.action === "assign_teacher") await setClubTeacherAssignment(actor.id, input.clubId, input.teacherId, input.assigned);
    if (input.action === "inspect_sheet") return Response.json({ ok: true, sheet: await inspectClubGoogleSheet(actor.id, input.versionId) });
    if (input.action === "create_sheet_tabs") return Response.json({ ok: true, sheet: await createClubGoogleSheetTabs(actor.id, input.versionId) });
    if (input.action === "test_sheet") return Response.json({ ok: true, sheet: await testClubGoogleSheet(actor.id, input.versionId) });
    if (input.action === "review_custom_response") await reviewCustomTabResponse(actor.id, input);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: error instanceof FormWriteConflict ? 409 : 400 });
  }
}
