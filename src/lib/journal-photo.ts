import { createHash } from "node:crypto";
import sharp from "sharp";
import { JournalAccessError, JOURNAL_MAX_IMAGE_BYTES, detectJournalImageType, type JournalPhotoInput } from "@/lib/journal-service";

/** Decode, apply EXIF rotation, resize and re-encode every upload, including small files. */
export async function normalizeJournalPhoto(photo: JournalPhotoInput): Promise<JournalPhotoInput> {
  if (!photo.data.length || photo.data.length > JOURNAL_MAX_IMAGE_BYTES || !detectJournalImageType(photo.data)) throw new JournalAccessError("실제 JPG, PNG, WebP 사진을 5MB 이하로 첨부해 주세요.");
  try {
    const input = sharp(photo.data, { failOn: "warning", limitInputPixels: 40_000_000 });
    const meta = await input.metadata();
    if ((meta.pages ?? 1) > 1) throw new Error("animated image");
    // sharp strips EXIF/XMP/IPTC/ICC metadata unless explicitly retained.
    const data = await input.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer();
    if (data.length > JOURNAL_MAX_IMAGE_BYTES) throw new Error("image too large");
    return { originalDigest: createHash("sha256").update(photo.data).digest("hex"), clientId: photo.clientId, contentType: "image/jpeg", fileName: "experiment-photo.jpg", data };
  } catch {
    throw new JournalAccessError("사진을 해석하지 못했습니다. 손상되지 않은 일반 사진으로 다시 선택해 주세요.");
  }
}
