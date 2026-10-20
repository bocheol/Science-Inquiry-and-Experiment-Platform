import sharp from "sharp";
import { expect, it } from "vitest";
import { normalizeJournalPhoto } from "@/lib/journal-photo";

it("normalizes small photos, applies rotation and strips original metadata", async () => {
  const data = await sharp({ create: { width: 32, height: 18, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const photo = { clientId: "synthetic-photo", contentType: "image/jpeg" as const, fileName: "private-name.jpg", data };
  const result = await normalizeJournalPhoto(photo);
  const metadata = await sharp(result.data).metadata();
  expect(metadata.width).toBe(18); expect(metadata.height).toBe(32);
  expect(metadata.exif).toBeUndefined(); expect(metadata.xmp).toBeUndefined(); expect(metadata.icc).toBeUndefined();
  expect(result.fileName).toBe("experiment-photo.jpg");
  expect((await normalizeJournalPhoto(photo)).data).toEqual(result.data);
});
it("bounds dimensions and rejects header-only fake images", async () => {
  const data = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "blue" } }).png().toBuffer();
  const result = await normalizeJournalPhoto({ clientId: "photo", contentType: "image/png", fileName: "photo.png", data });
  expect(await sharp(result.data).metadata()).toMatchObject({ width: 1600, height: 800 });
  await expect(normalizeJournalPhoto({ clientId: "invalid", contentType: "image/jpeg", fileName: "bad.jpg", data: Buffer.from([255, 216, 255, 0]) })).rejects.toThrow("해석");
});
