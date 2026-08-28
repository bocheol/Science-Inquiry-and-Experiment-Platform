import "client-only";

import type { JournalImage } from "@/lib/types";

const DATABASE_NAME = "science-inquiry-journal-drafts";
const STORE_NAME = "drafts";
const DATABASE_VERSION = 1;

export type StoredJournalPhoto = {
  clientId: string;
  fileName: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  blob: Blob;
};

export type StoredJournalDraft = {
  key: string;
  sessionId: string;
  sessionNumber: number;
  date: string;
  activities: string;
  observations: string;
  reflections: string;
  existingImages: JournalImage[];
  newPhotos: StoredJournalPhoto[];
  pendingSync: boolean;
  savedAt: string;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("임시 저장소를 열지 못했습니다."));
  });
}

async function runStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("임시 저장소 작업에 실패했습니다."));
    });
  } finally {
    database.close();
  }
}

export async function getJournalDraft(key: string) {
  return (await runStore<StoredJournalDraft | undefined>("readonly", (store) => store.get(key))) ?? null;
}

export async function putJournalDraft(draft: StoredJournalDraft) {
  await runStore<IDBValidKey>("readwrite", (store) => store.put(draft));
}

export async function deleteJournalDraft(key: string) {
  await runStore<undefined>("readwrite", (store) => store.delete(key));
}

export async function prepareJournalPhoto(file: File): Promise<StoredJournalPhoto> {
  const supported = ["image/jpeg", "image/png", "image/webp"] as const;
  if (!supported.includes(file.type as (typeof supported)[number])) throw new Error("JPG, PNG, WebP 사진만 첨부할 수 있습니다.");
  if (file.size <= 5 * 1024 * 1024) {
    return {
      clientId: crypto.randomUUID(),
      fileName: file.name.slice(0, 220) || "experiment-photo",
      contentType: file.type as StoredJournalPhoto["contentType"],
      blob: file,
    };
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, 1600 / longest);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("사진을 처리하지 못했습니다.");
    context.drawImage(bitmap, 0, 0, width, height);
    const outputType = file.type === "image/png" && file.size < 2 * 1024 * 1024 ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("사진을 압축하지 못했습니다.")),
      outputType,
      outputType === "image/jpeg" ? 0.84 : undefined,
    ));
    if (blob.size > 5 * 1024 * 1024) throw new Error("사진을 5MB 이하로 줄이지 못했습니다. 다른 사진을 선택해 주세요.");
    return {
      clientId: crypto.randomUUID(),
      fileName: `${file.name.replace(/\.[^.]+$/, "").slice(0, 180) || "experiment"}.${outputType === "image/png" ? "png" : "jpg"}`,
      contentType: outputType,
      blob,
    };
  } finally {
    bitmap.close();
  }
}
