"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteJournalDraft,
  getJournalDraft,
  prepareJournalPhoto,
  putJournalDraft,
  type StoredJournalDraft,
  type StoredJournalPhoto,
} from "@/lib/journal-drafts";
import type { ExperimentJournal, JournalImage } from "@/lib/types";
import { useToast } from "@/components/toast-provider";

type DraftFields = Pick<StoredJournalDraft, "sessionNumber" | "date" | "activities" | "observations" | "reflections">;
type PhotoWithPreview = StoredJournalPhoto & { previewUrl: string };

const today = () => new Date().toLocaleDateString("sv-SE");
const blankFields = (sessionNumber = 1): DraftFields => ({ sessionNumber, date: today(), activities: "", observations: "", reflections: "" });

export function JournalPanel({ sessionId, currentUserId }: { sessionId: string; currentUserId: string }) {
  const { showToast } = useToast();
  const draftKey = `${sessionId}:${currentUserId}`;
  const [journals, setJournals] = useState<ExperimentJournal[]>([]);
  const [fields, setFields] = useState<DraftFields>(() => blankFields());
  const [existingImages, setExistingImages] = useState<JournalImage[]>([]);
  const [newPhotos, setNewPhotos] = useState<PhotoWithPreview[]>([]);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stateRef = useRef({ fields, existingImages, newPhotos, pendingSync });
  stateRef.current = { fields, existingImages, newPhotos, pendingSync };

  const nextSessionNumber = useMemo(
    () => Math.min(100, Math.max(0, ...journals.map((journal) => journal.sessionNumber)) + 1),
    [journals],
  );

  const revokePhotos = useCallback((photos: PhotoWithPreview[]) => {
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
  }, []);

  const loadJournals = useCallback(async () => {
    const response = await fetch(`/api/inquiry/journals?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    const result = (await response.json()) as { journals?: ExperimentJournal[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "실험 일지를 불러오지 못했습니다.");
    setJournals(result.journals ?? []);
    return result.journals ?? [];
  }, [sessionId]);

  const sendDraft = useCallback(async (draft: StoredJournalDraft) => {
    const formData = new FormData();
    formData.set("sessionId", draft.sessionId);
    formData.set("sessionNumber", String(draft.sessionNumber));
    formData.set("date", draft.date);
    formData.set("activities", draft.activities);
    formData.set("observations", draft.observations);
    formData.set("reflections", draft.reflections);
    formData.set("existingImageIds", JSON.stringify(draft.existingImages.map((image) => image.id)));
    formData.set("photoClientIds", JSON.stringify(draft.newPhotos.map((photo) => photo.clientId)));
    for (const photo of draft.newPhotos) formData.append("photos", new File([photo.blob], photo.fileName, { type: photo.contentType }));
    const response = await fetch("/api/inquiry/journals", { method: "POST", body: formData });
    const result = (await response.json()) as { journal?: ExperimentJournal; message?: string };
    if (!response.ok || !result.journal) {
      const failure = new Error(result.message ?? "실험 일지를 저장하지 못했습니다.") as Error & { retriable?: boolean };
      failure.retriable = response.status >= 500;
      throw failure;
    }
    return result.journal;
  }, []);

  const finishSync = useCallback(async (journal: ExperimentJournal) => {
    await deleteJournalDraft(draftKey);
    revokePhotos(stateRef.current.newPhotos);
    setNewPhotos([]);
    setExistingImages(journal.images);
    setFields({
      sessionNumber: journal.sessionNumber,
      date: journal.date,
      activities: journal.activities,
      observations: journal.observations,
      reflections: journal.reflections,
    });
    setJournals((current) => [journal, ...current.filter((item) => item.id !== journal.id)]
      .sort((left, right) => right.sessionNumber - left.sessionNumber));
    setDirty(false);
    setPendingSync(false);
    setNotice(`${journal.sessionNumber}차시 일지를 저장했습니다.`);
    showToast(`${journal.sessionNumber}차시 실험 일지를 저장했습니다.`);
  }, [draftKey, revokePhotos, showToast]);

  const makeStoredDraft = useCallback((pending: boolean): StoredJournalDraft => ({
    key: draftKey,
    sessionId,
    ...stateRef.current.fields,
    existingImages: stateRef.current.existingImages,
    newPhotos: stateRef.current.newPhotos.map(({ previewUrl: _previewUrl, ...photo }) => photo),
    pendingSync: pending,
    savedAt: new Date().toISOString(),
  }), [draftKey, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [serverJournals, draft] = await Promise.all([loadJournals(), getJournalDraft(draftKey)]);
        if (cancelled) return;
        if (draft) {
          setFields({
            sessionNumber: draft.sessionNumber,
            date: draft.date,
            activities: draft.activities,
            observations: draft.observations,
            reflections: draft.reflections,
          });
          setExistingImages(draft.existingImages);
          setNewPhotos(draft.newPhotos.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.blob) })));
          setDirty(true);
          setPendingSync(draft.pendingSync);
          setNotice(draft.pendingSync ? "전송을 기다리던 일지를 복구했습니다." : "기기에 임시 저장된 작성 내용을 복구했습니다.");
          if (draft.pendingSync && navigator.onLine) window.setTimeout(() => window.dispatchEvent(new Event("online")), 0);
        } else {
          setFields(blankFields(Math.min(100, Math.max(0, ...serverJournals.map((journal) => journal.sessionNumber)) + 1)));
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "실험 일지를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [draftKey, loadJournals]);

  useEffect(() => {
    if (!ready || !dirty) return;
    const timer = window.setTimeout(() => {
      void putJournalDraft(makeStoredDraft(pendingSync)).catch(() => setError("기기 임시 저장에 실패했습니다."));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [dirty, fields, existingImages, makeStoredDraft, newPhotos, pendingSync, ready]);

  useEffect(() => {
    const retry = () => {
      setOnline(true);
      void (async () => {
        const draft = await getJournalDraft(draftKey);
        if (!draft?.pendingSync) return;
        setBusy(true);
        try {
          await finishSync(await sendDraft(draft));
        } catch {
          setNotice("연결이 불안정합니다. 작성 내용은 이 기기에 보존되어 있습니다.");
        } finally {
          setBusy(false);
        }
      })();
    };
    const markOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", retry);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("offline", markOffline);
    };
  }, [draftKey, finishSync, sendDraft]);

  function updateField<K extends keyof DraftFields>(key: K, value: DraftFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function openJournal(journal: ExperimentJournal) {
    revokePhotos(newPhotos);
    setNewPhotos([]);
    setExistingImages(journal.images);
    setFields({ sessionNumber: journal.sessionNumber, date: journal.date, activities: journal.activities, observations: journal.observations, reflections: journal.reflections });
    setDirty(false);
    setPendingSync(false);
    setError("");
    setNotice(`${journal.sessionNumber}차시 일지를 열었습니다. 수정 후 저장하면 기존 내용이 갱신됩니다.`);
    void deleteJournalDraft(draftKey);
  }

  function startNew() {
    revokePhotos(newPhotos);
    setNewPhotos([]);
    setExistingImages([]);
    setFields(blankFields(nextSessionNumber));
    setDirty(false);
    setPendingSync(false);
    setError("");
    setNotice("새 차시 일지를 작성합니다.");
    void deleteJournalDraft(draftKey);
  }

  async function addPhotos(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (existingImages.length + newPhotos.length + files.length > 5) return setError("사진은 차시당 5장까지 첨부할 수 있습니다.");
    setBusy(true); setError("");
    try {
      const prepared = await Promise.all(files.map(prepareJournalPhoto));
      setNewPhotos((current) => [...current, ...prepared.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.blob) }))]);
      setDirty(true);
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : "사진을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(""); setNotice("");
    if (!fields.activities.trim() || !fields.observations.trim()) return setError("오늘 한 일과 관찰 결과를 모두 적어 주세요.");
    const queued = makeStoredDraft(true);
    setPendingSync(true);
    setDirty(true);
    await putJournalDraft(queued);
    if (!online) return setNotice("인터넷 연결이 돌아오면 자동으로 전송합니다. 작성 내용과 사진은 이 기기에 보존되어 있습니다.");
    setBusy(true);
    try {
      await finishSync(await sendDraft(queued));
    } catch (saveError) {
      const typed = saveError as Error & { retriable?: boolean };
      if (!typed.retriable) {
        setPendingSync(false);
        await putJournalDraft({ ...queued, pendingSync: false });
      }
      setError(typed.message);
      showToast(typed.message, "error");
      setNotice(typed.retriable ? "연결이 복구되면 자동으로 다시 전송합니다." : "작성 내용은 이 기기에 임시 저장되어 있습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="journal-layout">
      <div className="journal-editor">
        <div className="page-title journal-title">
          <div><h1>개인 실험 일지</h1><p>이 내용은 본인과 선생님만 볼 수 있습니다. 입력 내용은 기기에 자동 임시 저장됩니다.</p></div>
          <button className="button ghost" type="button" onClick={startNew}>+ 새 차시</button>
        </div>
        {!online || pendingSync ? <div className="warning-box">{online ? "저장 요청을 다시 전송하고 있습니다." : "오프라인 상태입니다. 연결되면 저장 요청을 자동 전송합니다."}</div> : null}
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        {notice ? <div className="notice-box">{notice}</div> : null}
        <div className="journal-meta-grid">
          <div className="field"><label htmlFor="journal-session">차시</label><input id="journal-session" className="input" type="number" min={1} max={100} value={fields.sessionNumber} onChange={(event) => updateField("sessionNumber", Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></div>
          <div className="field"><label htmlFor="journal-date">날짜</label><input id="journal-date" className="input" type="date" value={fields.date} onChange={(event) => updateField("date", event.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="journal-activities">오늘 한 일</label><textarea id="journal-activities" className="textarea" value={fields.activities} onChange={(event) => updateField("activities", event.target.value)} placeholder="내가 맡아서 한 일과 실험 과정을 구체적으로 기록하세요." maxLength={10_000} /></div>
        <div className="field"><label htmlFor="journal-observations">관찰 결과</label><textarea id="journal-observations" className="textarea" value={fields.observations} onChange={(event) => updateField("observations", event.target.value)} placeholder="측정값, 변화, 예상과 달랐던 점을 기록하세요." maxLength={10_000} /></div>
        <div className="field"><label htmlFor="journal-reflections">느낀 점 / 궁금한 점</label><textarea id="journal-reflections" className="textarea" value={fields.reflections} onChange={(event) => updateField("reflections", event.target.value)} placeholder="다음 차시에 확인할 점이나 새로 생긴 질문을 적어 보세요." maxLength={10_000} /></div>
        <div className="field">
          <div className="field-heading"><label htmlFor="journal-photos">실험 사진 (선택)</label><span className="save-state">{existingImages.length + newPhotos.length}/5장</span></div>
          <input id="journal-photos" className="input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={addPhotos} disabled={busy || existingImages.length + newPhotos.length >= 5} />
          <p className="section-subtitle" style={{ margin: 0 }}>큰 사진은 태블릿에서 자동으로 줄여 저장합니다.</p>
        </div>
        <div className="journal-photo-grid">
          {existingImages.map((image) => <figure className="journal-photo" key={image.id}><img src={image.url} alt="저장된 실험 사진" /><button type="button" onClick={() => { setExistingImages((current) => current.filter((item) => item.id !== image.id)); setDirty(true); }}>사진 제거</button></figure>)}
          {newPhotos.map((photo) => <figure className="journal-photo" key={photo.clientId}><img src={photo.previewUrl} alt="새 실험 사진 미리보기" /><button type="button" onClick={() => { URL.revokeObjectURL(photo.previewUrl); setNewPhotos((current) => current.filter((item) => item.clientId !== photo.clientId)); setDirty(true); }}>사진 제거</button></figure>)}
        </div>
        <div className="journal-save-bar"><span>{dirty ? "기기에 임시 저장됨" : "서버 저장 내용"}</span><button className="button" type="button" onClick={save} disabled={busy || !ready}>{busy ? "저장 중…" : "일지 저장"}</button></div>
      </div>
      <aside className="journal-history">
        <h2 className="section-heading">이전 일지</h2>
        {journals.map((journal) => <button className={`journal-history-item ${journal.sessionNumber === fields.sessionNumber ? "active" : ""}`} type="button" key={journal.id} onClick={() => openJournal(journal)}><b>{journal.sessionNumber}차시</b><span>{journal.date}</span><small>사진 {journal.images.length}장</small></button>)}
        {!journals.length ? <div className="empty-state">저장된 일지가 없습니다.</div> : null}
      </aside>
    </section>
  );
}
