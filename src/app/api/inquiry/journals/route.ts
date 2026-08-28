import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  detectJournalImageType,
  JOURNAL_MAX_IMAGE_BYTES,
  JOURNAL_MAX_IMAGES,
  JournalAccessError,
  listStudentJournals,
  saveStudentJournal,
  type JournalPhotoInput,
} from "@/lib/journal-service";

const querySchema = z.string().trim().min(1).max(200);
const journalSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  sessionNumber: z.coerce.number().int().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activities: z.string().trim().min(1, "오늘 한 일을 적어 주세요.").max(10_000),
  observations: z.string().trim().min(1, "관찰 결과를 적어 주세요.").max(10_000),
  reflections: z.string().trim().max(10_000),
  existingImageIds: z.array(z.string().trim().min(1).max(200)).max(JOURNAL_MAX_IMAGES),
  photoClientIds: z.array(z.string().trim().min(8).max(200)).max(JOURNAL_MAX_IMAGES),
});

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof JournalAccessError) return NextResponse.json({ message: error.message }, { status: error.status });
  return NextResponse.json({ message: error instanceof Error ? error.message : fallback }, { status: 400 });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = querySchema.safeParse(new URL(request.url).searchParams.get("sessionId"));
  if (!parsed.success) return NextResponse.json({ message: "탐구 세션을 확인해 주세요." }, { status: 400 });
  try {
    return NextResponse.json({ journals: await listStudentJournals(user, parsed.data) });
  } catch (error) {
    return errorResponse(error, "실험 일지를 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  try {
    const formData = await request.formData();
    const parseJsonArray = (name: string) => {
      const raw = formData.get(name);
      if (typeof raw !== "string") return [];
      try { return JSON.parse(raw) as unknown; } catch { return null; }
    };
    const parsed = journalSchema.safeParse({
      sessionId: formData.get("sessionId"),
      sessionNumber: formData.get("sessionNumber"),
      date: formData.get("date"),
      activities: formData.get("activities"),
      observations: formData.get("observations"),
      reflections: formData.get("reflections") ?? "",
      existingImageIds: parseJsonArray("existingImageIds"),
      photoClientIds: parseJsonArray("photoClientIds"),
    });
    if (!parsed.success) {
      return NextResponse.json({ message: parsed.error.issues[0]?.message ?? "일지 내용을 확인해 주세요." }, { status: 400 });
    }
    const files = formData.getAll("photos").filter((value): value is File => value instanceof File);
    if (files.length !== parsed.data.photoClientIds.length || files.length + parsed.data.existingImageIds.length > JOURNAL_MAX_IMAGES) {
      return NextResponse.json({ message: `사진은 차시당 ${JOURNAL_MAX_IMAGES}장까지 첨부할 수 있습니다.` }, { status: 400 });
    }
    const photos: JournalPhotoInput[] = [];
    for (const [index, file] of files.entries()) {
      const data = Buffer.from(await file.arrayBuffer());
      if (data.length <= 0 || data.length > JOURNAL_MAX_IMAGE_BYTES) {
        return NextResponse.json({ message: "사진 한 장의 크기는 5MB 이하여야 합니다." }, { status: 400 });
      }
      const contentType = detectJournalImageType(data);
      if (!contentType) return NextResponse.json({ message: "실제 JPG, PNG, WebP 사진만 첨부할 수 있습니다." }, { status: 400 });
      photos.push({
        clientId: parsed.data.photoClientIds[index]!,
        contentType,
        fileName: file.name.slice(0, 255) || `journal-photo-${index + 1}`,
        data,
      });
    }
    const journal = await saveStudentJournal(user, { ...parsed.data, photos });
    return NextResponse.json({ ok: true, journal });
  } catch (error) {
    return errorResponse(error, "실험 일지를 저장하지 못했습니다.");
  }
}
