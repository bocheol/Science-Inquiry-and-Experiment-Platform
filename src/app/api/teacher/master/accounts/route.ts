import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import {
  changeManagedAccountStatus,
  createManagedAccount,
  getMasterAccountData,
  resetManagedAccountPassword,
} from "@/lib/master-accounts";
import { userFacingMessage } from "@/lib/user-facing-error";

const createSchema = z.object({
  action: z.literal("create"),
  kind: z.enum(["teacher", "demo"]),
  name: z.string().trim().min(1).max(80),
  loginId: z.string().trim().min(3).max(40),
});

const changeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deactivate"), accountId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("restore"), accountId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("resetPassword"), accountId: z.string().min(1).max(200) }),
]);

async function masterUser() {
  const user = await getCurrentUser();
  return user?.role === "teacher" && user.isMaster && !user.mustChangePassword ? user : null;
}

export async function GET() {
  const user = await masterUser();
  if (!user) return Response.json({ message: "마스터 관리자 권한이 필요합니다." }, { status: 403 });
  try {
    return Response.json(await getMasterAccountData(user.id));
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "계정 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const user = await masterUser();
  if (!user) return Response.json({ message: "마스터 관리자 권한이 필요합니다." }, { status: 403 });
  const parsed = createSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "계정 종류, 이름과 아이디를 확인해 주세요." }, { status: 400 });
  try {
    const credential = await createManagedAccount(user.id, parsed.data);
    return Response.json({ ok: true, credential });
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "계정을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const user = await masterUser();
  if (!user) return Response.json({ message: "마스터 관리자 권한이 필요합니다." }, { status: 403 });
  const parsed = changeSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ message: "계정 변경 요청을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "resetPassword") {
      const credential = await resetManagedAccountPassword(user.id, parsed.data.accountId);
      return Response.json({ ok: true, credential });
    }
    await changeManagedAccountStatus(user.id, parsed.data.accountId, parsed.data.action);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ message: userFacingMessage(error, "계정을 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}
