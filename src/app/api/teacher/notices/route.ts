import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  createAnnouncement,
  listTeacherAnnouncements,
  NOTICE_AUDIENCES,
  setAnnouncementArchived,
  updateAnnouncement,
} from "@/lib/notices";
import { sendPushForNotice } from "@/lib/push-notifications";

const announcementFields = {
  title: z.string().trim().min(2).max(120),
  content: z.string().trim().min(2).max(5000),
  audienceType: z.enum(NOTICE_AUDIENCES),
  classNumber: z.number().int().min(1).max(9).nullable().optional(),
  teamId: z.string().trim().min(1).max(200).nullable().optional(),
  priority: z.enum(["normal", "important"]),
  calendarStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  calendarEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
};

const createSchema = z.object({ ...announcementFields, sendPush: z.boolean().default(false) });
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), noticeId: z.string().min(1).max(200), sendPush: z.boolean().default(false), ...announcementFields }),
  z.object({ action: z.literal("archive"), noticeId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("restore"), noticeId: z.string().min(1).max(200) }),
]);

async function requireTeacher() {
  const user = await getCurrentUser();
  return user?.role === "teacher" && !user.mustChangePassword ? user : null;
}

export async function GET() {
  const user = await requireTeacher();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  return NextResponse.json({ notices: await listTeacherAnnouncements(user) });
}

export async function POST(request: Request) {
  const user = await requireTeacher();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "공지 대상·제목·내용·일정을 확인해 주세요." }, { status: 400 });
  try {
    const { sendPush, ...input } = parsed.data;
    const id = await createAnnouncement(user, input);
    const push = sendPush ? await sendPushForNotice(id) : null;
    return NextResponse.json({ ok: true, id, push });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "공지를 등록하지 못했습니다." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const user = await requireTeacher();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "공지 변경 요청을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "update") {
      const { noticeId, action: _action, sendPush, ...input } = parsed.data;
      await updateAnnouncement(user, noticeId, input);
      const push = sendPush ? await sendPushForNotice(noticeId) : null;
      return NextResponse.json({ ok: true, push });
    } else {
      await setAnnouncementArchived(user, parsed.data.noticeId, parsed.data.action === "archive");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "공지를 변경하지 못했습니다." }, { status: 400 });
  }
}
