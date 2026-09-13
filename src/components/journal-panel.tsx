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
import { FormConflict } from "@/components/form-conflict";

type DraftFields = Pick<StoredJournalDraft, "sessionNumber" | "date" | "activities" | "observations" | "reflections">;
type PhotoWithPreview = StoredJournalPhoto & { previewUrl: string };

const today = () => new Date().toLocaleDateString("sv-SE");
const blankFields = (sessionNumber = 1): DraftFields => ({ sessionNumber, date: today(), activities: "", observations: "", reflections: "" });
const draftMatchesJournal = (draft: StoredJournalDraft, journal: ExperimentJournal) => {
  const clients = new Set([...draft.existingImages.map(image => image.clientId), ...draft.newPhotos.map(photo => photo.clientId)]);
  return draft.date === journal.date && draft.activities === journal.activities && draft.observations === journal.observations
    && draft.reflections === journal.reflections && clients.size === journal.images.length
    && journal.images.every(image => clients.has(image.clientId));
};

export function JournalPanel({ sessionId, cycleId, currentUserId }: { sessionId: string; cycleId: string; currentUserId: string }) {
  const { showToast } = useToast();
  const draftKey = `${sessionId}:${cycleId}:${currentUserId}`;
  const [journals, setJournals] = useState<ExperimentJournal[]>([]);
  const [fields, setFields] = useState<DraftFields>(() => blankFields());
  const [existingImages, setExistingImages] = useState<JournalImage[]>([]);
  const [newPhotos, setNewPhotos] = useState<PhotoWithPreview[]>([]);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [baseVersion, setBaseVersion] = useState<number | null | undefined>(null);
  const [conflictServer, setConflictServer] = useState<ExperimentJournal | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stateRef = useRef({ fields, existingImages, newPhotos, pendingSync, baseVersion });
  stateRef.current = { fields, existingImages, newPhotos, pendingSync, baseVersion };
  const editVersion = useRef(0);
  const sending = useRef(false);
  const draftWriteTail = useRef<Promise<void>>(Promise.resolve());
  const lifecycle = useRef({ ready, dirty });
  lifecycle.current = { ready, dirty };

  const queueDraftStore = useCallback(<T,>(action: () => Promise<T>) => {
    const run = draftWriteTail.current.then(action, action);
    draftWriteTail.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);
  const persistDraft = useCallback((draft: StoredJournalDraft) => queueDraftStore(() => putJournalDraft(draft)), [queueDraftStore]);
  const removeDraft = useCallback(() => queueDraftStore(() => deleteJournalDraft(draftKey)), [draftKey, queueDraftStore]);

  const makeStoredDraft = useCallback((pending: boolean): StoredJournalDraft => ({
    key: draftKey,
    sessionId,
    ...stateRef.current.fields,
    baseVersion: stateRef.current.baseVersion,
    existingImages: stateRef.current.existingImages,
    newPhotos: stateRef.current.newPhotos.map(({ previewUrl: _previewUrl, ...photo }) => photo),
    pendingSync: pending,
    savedAt: new Date().toISOString(),
  }), [draftKey, sessionId]);

  const nextSessionNumber = useMemo(
    () => Math.min(100, Math.max(0, ...journals.map((journal) => journal.sessionNumber)) + 1),
    [journals],
  );

  const revokePhotos = useCallback((photos: PhotoWithPreview[]) => {
    for (const photo of photos) URL.revokeObjectURL(photo.previewUrl);
  }, []);

  const loadJournals = useCallback(async () => {
    const response = await fetch(`/api/inquiry/journals?sessionId=${encodeURIComponent(sessionId)}&cycleId=${encodeURIComponent(cycleId)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const result = (await response.json()) as { journals?: ExperimentJournal[]; message?: string };
    if (!response.ok) throw new Error(result.message ?? "실험 일지를 불러오지 못했습니다.");
    setJournals(result.journals ?? []);
    return result.journals ?? [];
  }, [sessionId, cycleId]);

  const sendDraft = useCallback(async (draft: StoredJournalDraft) => {
    const formData = new FormData();
    formData.set("sessionId", draft.sessionId);
    formData.set("cycleId", cycleId);
    formData.set("sessionNumber", String(draft.sessionNumber));
    formData.set("date", draft.date);
    formData.set("activities", draft.activities);
    formData.set("observations", draft.observations);
    formData.set("reflections", draft.reflections);
    formData.set("expectedVersion", draft.baseVersion === undefined ? "unknown" : JSON.stringify(draft.baseVersion));
    formData.set("existingImageIds", JSON.stringify(draft.existingImages.map((image) => image.id)));
    formData.set("photoClientIds", JSON.stringify(draft.newPhotos.map((photo) => photo.clientId)));
    for (const photo of draft.newPhotos) formData.append("photos", new File([photo.blob], photo.fileName, { type: photo.contentType }));
    const response = await fetch("/api/inquiry/journals", { method: "POST", body: formData, signal: AbortSignal.timeout(30_000) }).catch(() => {
      throw Object.assign(new Error("연결이 불안정해 일지를 전송하지 못했습니다."), { retriable: true });
    });
    const result = (await response.json()) as { journal?: ExperimentJournal; message?: string };
    if (!response.ok || !result.journal) {
      const failure = new Error(result.message ?? "실험 일지를 저장하지 못했습니다.") as Error & { retriable?: boolean; status?: number };
      failure.retriable = response.status >= 500;
      failure.status = response.status;
      throw failure;
    }
    return result.journal;
  }, []);

  const finishSync = useCallback(async (journal: ExperimentJournal, version: number) => {
    setError("");
    setJournals((current) => [journal, ...current.filter((item) => item.id !== journal.id)]
      .sort((left, right) => right.sessionNumber - left.sessionNumber));
    if (editVersion.current === version) await removeDraft();
    // Recheck after the asynchronous delete too: typing may continue meanwhile.
    if (editVersion.current !== version) {
      if (stateRef.current.fields.sessionNumber === journal.sessionNumber) {
        stateRef.current.baseVersion = journal.version;
        setBaseVersion(journal.version);
      }
      setPendingSync(false);
      setDirty(true);
      await persistDraft(makeStoredDraft(false));
      setNotice("앞선 내용은 저장했습니다. 그 뒤 작성한 내용은 보존했으니 다시 저장해 주세요.");
      return;
    }
    revokePhotos(stateRef.current.newPhotos);
    setNewPhotos([]);
    setExistingImages(journal.images);
    setBaseVersion(journal.version);
    setFields({
      sessionNumber: journal.sessionNumber,
      date: journal.date,
      activities: journal.activities,
      observations: journal.observations,
      reflections: journal.reflections,
    });
    setDirty(false);
    setPendingSync(false);
    setNotice(`${journal.sessionNumber}차시 일지를 저장했습니다.`);
    showToast(`${journal.sessionNumber}차시 실험 일지를 저장했습니다.`);
  }, [makeStoredDraft, persistDraft, removeDraft, revokePhotos, showToast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [serverResult, draftResult] = await Promise.allSettled([loadJournals(), getJournalDraft(draftKey)]);
        if (cancelled) return;
        const serverJournals = serverResult.status === "fulfilled" ? serverResult.value : [];
        const draft = draftResult.status === "fulfilled" ? draftResult.value : null;
        if (serverResult.status === "rejected") setError("서버 일지를 불러오지 못했습니다. 기기에 남은 초안을 먼저 확인해 주세요.");
        if (draftResult.status === "rejected") setError("기기 임시 저장소를 열지 못했습니다. 작성 내용은 별도로 복사해 보관해 주세요.");
        if (draft) {
          const server = serverJournals.find(journal => journal.sessionNumber === draft.sessionNumber) ?? null;
          const latestVersion = server?.version ?? null;
          setFields({
            sessionNumber: draft.sessionNumber,
            date: draft.date,
            activities: draft.activities,
            observations: draft.observations,
            reflections: draft.reflections,
          });
          const restoredPhotos = draft.newPhotos.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.blob) }));
          setExistingImages(draft.existingImages);
          setNewPhotos(restoredPhotos);
          setBaseVersion(Object.hasOwn(draft, "baseVersion") ? draft.baseVersion : (server ? undefined : null));
          setDirty(true);
          setPendingSync(draft.pendingSync);
          if (server && draftMatchesJournal(draft, server)) {
            revokePhotos(restoredPhotos);
            setExistingImages(server.images);
            setNewPhotos([]);
            setFields({ sessionNumber: server.sessionNumber, date: server.date, activities: server.activities, observations: server.observations, reflections: server.reflections });
            setBaseVersion(server.version);
            setDirty(false);
            setPendingSync(false);
            setNotice("이전에 응답을 받지 못한 일지가 서버에 저장된 것을 확인했습니다.");
            void removeDraft();
          } else {
            if (serverResult.status === "fulfilled"
              && (draft.baseVersion === undefined ? Boolean(server) : draft.baseVersion !== latestVersion)) setConflictServer(server);
            setNotice(draft.pendingSync ? "전송을 기다리던 일지를 복구했습니다." : "기기에 임시 저장된 작성 내용을 복구했습니다.");
          }
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
  }, [draftKey, loadJournals, removeDraft, revokePhotos]);

  useEffect(() => {
    if (!ready || !dirty) return;
    const timer = window.setTimeout(() => {
      void persistDraft(makeStoredDraft(pendingSync)).catch(() => setError("기기 임시 저장에 실패했습니다."));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [dirty, fields, existingImages, makeStoredDraft, newPhotos, pendingSync, persistDraft, ready]);

  useEffect(() => {
    const flush = () => {
      if (lifecycle.current.ready && lifecycle.current.dirty) {
        void persistDraft(makeStoredDraft(stateRef.current.pendingSync)).catch(() => setError("기기 임시 저장에 실패했습니다. 글을 복사해 보관해 주세요."));
      }
    };
    const checkLatest = () => {
      if (!lifecycle.current.ready || !lifecycle.current.dirty) return;
      void loadJournals().then((latest) => {
        const current = stateRef.current;
        const server = latest.find(journal => journal.sessionNumber === current.fields.sessionNumber) ?? null;
        if (current.baseVersion === undefined || current.baseVersion !== (server?.version ?? null)) setConflictServer(server);
      }).catch(() => setNotice("최신 저장 내용을 확인하지 못했습니다. 작성 내용은 기기에 유지됩니다."));
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); else checkLatest(); };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (lifecycle.current.dirty) { flush(); event.preventDefault(); event.returnValue = ""; }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("pageshow", checkLatest);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("pageshow", checkLatest);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [loadJournals, makeStoredDraft, persistDraft]);

  useEffect(() => {
    const markOnline = () => {
      setOnline(true);
      if (stateRef.current.pendingSync) setNotice("연결이 복구되었습니다. 내용을 확인하고 임시 저장을 눌러 주세요.");
    };
    const markOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  function updateField<K extends keyof DraftFields>(key: K, value: DraftFields[K]) {
    editVersion.current += 1;
    const next = { ...stateRef.current.fields, [key]: value };
    stateRef.current.fields = next;
    setFields(next);
    if (key === "sessionNumber") {
      const server = journals.find(journal => journal.sessionNumber === value) ?? null;
      stateRef.current.existingImages = [];
      setExistingImages([]);
      stateRef.current.baseVersion = server?.version ?? null;
      setBaseVersion(server?.version ?? null);
      setConflictServer(server ?? undefined);
    }
    setDirty(true);
  }

  function openJournal(journal: ExperimentJournal) {
    if (busy || !ready || (dirty && !window.confirm("저장하지 않은 현재 초안을 버리고 이전 일지를 열까요?"))) return;
    editVersion.current += 1;
    revokePhotos(newPhotos);
    setNewPhotos([]);
    setExistingImages(journal.images);
    setBaseVersion(journal.version);
    setConflictServer(undefined);
    setFields({ sessionNumber: journal.sessionNumber, date: journal.date, activities: journal.activities, observations: journal.observations, reflections: journal.reflections });
    setDirty(false);
    setPendingSync(false);
    setError("");
    setNotice(`${journal.sessionNumber}차시 일지를 열었습니다. 수정 후 저장하면 기존 내용이 갱신됩니다.`);
    void removeDraft().catch(() => setError("이전 초안을 정리하지 못했습니다."));
  }

  function startNew() {
    if (busy || !ready || (dirty && !window.confirm("저장하지 않은 현재 초안을 버리고 새 차시를 작성할까요?"))) return;
    editVersion.current += 1;
    revokePhotos(newPhotos);
    setNewPhotos([]);
    setExistingImages([]);
    setBaseVersion(null);
    setConflictServer(undefined);
    setFields(blankFields(nextSessionNumber));
    setDirty(false);
    setPendingSync(false);
    setError("");
    setNotice("새 차시 일지를 작성합니다.");
    void removeDraft().catch(() => setError("이전 초안을 정리하지 못했습니다."));
  }

  async function addPhotos(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (existingImages.length + newPhotos.length + files.length > 5) return setError("사진은 차시당 5장까지 첨부할 수 있습니다.");
    setBusy(true); setError("");
    try {
      const prepared = await Promise.all(files.map(prepareJournalPhoto));
      editVersion.current += 1;
      setNewPhotos((current) => [...current, ...prepared.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.blob) }))]);
      setDirty(true);
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : "사진을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function resolveConflict(keepMine: boolean) {
    if (conflictServer === undefined) return;
    editVersion.current += 1;
    const server = conflictServer;
    if (!keepMine) {
      revokePhotos(stateRef.current.newPhotos);
      const nextFields = server
        ? { sessionNumber: server.sessionNumber, date: server.date, activities: server.activities, observations: server.observations, reflections: server.reflections }
        : blankFields(stateRef.current.fields.sessionNumber);
      const nextImages = server?.images ?? [];
      stateRef.current = { fields: nextFields, existingImages: nextImages, newPhotos: [], pendingSync: false, baseVersion: server?.version ?? null };
      setFields(nextFields); setExistingImages(nextImages); setNewPhotos([]); setBaseVersion(server?.version ?? null);
      setDirty(false); setPendingSync(false); setConflictServer(undefined); setError("");
      setNotice("최신 저장 내용을 사용했습니다.");
      void removeDraft().catch(() => setError("이전 초안을 정리하지 못했습니다."));
      return;
    }
    const available = new Map((server?.images ?? []).map(image => [image.id, image]));
    const selectedImages = stateRef.current.existingImages.flatMap(image => available.has(image.id) ? [available.get(image.id)!] : []);
    const unavailableCount = stateRef.current.existingImages.length - selectedImages.length;
    stateRef.current.existingImages = selectedImages;
    stateRef.current.baseVersion = server?.version ?? null;
    stateRef.current.pendingSync = false;
    setExistingImages(selectedImages); setBaseVersion(server?.version ?? null); setPendingSync(false);
    setDirty(true); setConflictServer(undefined); setError("");
    setNotice(unavailableCount
      ? "내 글과 새 사진을 유지했습니다. 다른 기기에서 이미 지운 저장 사진은 복원할 수 없어 제외했습니다. 확인 후 임시 저장을 눌러 주세요."
      : "내 작성 내용을 최신 저장 번호에 맞췄습니다. 확인 후 임시 저장을 눌러 서버에 반영해 주세요.");
    void persistDraft(makeStoredDraft(false)).catch(() => setError("기기 임시 저장에 실패했습니다."));
  }

  async function save() {
    if (!ready || busy || sending.current) return;
    setError(""); setNotice("");
    if (conflictServer !== undefined || baseVersion === undefined) return setError("최신 저장 내용과 내 초안을 먼저 비교해 주세요.");
    if (!fields.activities.trim() || !fields.observations.trim()) return setError("오늘 한 일과 관찰 결과를 모두 적어 주세요.");
    const queued = makeStoredDraft(true);
    const version = editVersion.current;
    sending.current = true;
    setPendingSync(true);
    setDirty(true);
    setBusy(true);
    try {
      await persistDraft(queued);
      if (!online) return setNotice("작성 내용과 사진은 이 기기에 보관했습니다. 연결이 돌아오면 임시 저장을 다시 눌러 주세요.");
      await finishSync(await sendDraft(queued), version);
    } catch (saveError) {
      const typed = saveError as Error & { retriable?: boolean; status?: number };
      if (!typed.retriable) {
        setPendingSync(false);
      }
      let failureMessage = typed.message;
      if (typed.status === 409) {
        try {
          const latest = await loadJournals();
          setConflictServer(latest.find(journal => journal.sessionNumber === stateRef.current.fields.sessionNumber) ?? null);
        } catch {
          stateRef.current.baseVersion = undefined;
          setBaseVersion(undefined);
          failureMessage = "다른 기기의 저장과 충돌했고 최신 내용을 아직 불러오지 못했습니다. 작성 내용은 유지됩니다. 페이지로 돌아오면 다시 확인합니다.";
        }
      }
      await persistDraft(makeStoredDraft(Boolean(typed.retriable))).catch(() => setNotice("기기 임시 저장에도 실패했습니다. 화면의 글을 복사해 보관해 주세요."));
      setError(failureMessage);
      showToast(failureMessage, "error");
      if (typed.retriable) setNotice("작성 내용은 기기에 보관됩니다. 연결이 복구되면 임시 저장을 다시 눌러 주세요.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (!ready) return <div className="empty-state">실험 일지와 기기 초안을 불러오는 중…</div>;

  return (
    <section className="journal-layout">
      <div className="journal-editor">
        <div className="page-title journal-title">
          <div><h1>개인 실험 일지</h1><p>작성 중인 글과 사진은 기기에 복구용으로 보관됩니다. 임시 저장을 눌러야 서버에 저장되며 본인과 선생님만 볼 수 있습니다.</p></div>
          <button className="button ghost" type="button" onClick={startNew}>+ 새 차시</button>
        </div>
        {conflictServer !== undefined ? <FormConflict rows={[
          { label: "날짜", mine: fields.date, server: conflictServer?.date ?? "" },
          { label: "오늘 한 일", mine: fields.activities, server: conflictServer?.activities ?? "" },
          { label: "관찰 결과", mine: fields.observations, server: conflictServer?.observations ?? "" },
          { label: "느낀 점 / 궁금한 점", mine: fields.reflections, server: conflictServer?.reflections ?? "" },
          { label: "사진", mine: `${existingImages.length + newPhotos.length}장`, server: `${conflictServer?.images.length ?? 0}장` },
        ]} onResolve={resolveConflict} /> : null}
        {!online || pendingSync ? <div className="warning-box">{online ? "서버에 저장되지 않은 내용이 있습니다. 임시 저장을 눌러 주세요." : "오프라인 상태입니다. 작성 내용은 기기에 보관되며 연결 후 임시 저장을 눌러야 서버에 반영됩니다."}</div> : null}
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
          {existingImages.map((image) => <figure className="journal-photo" key={image.id}><img src={image.url} alt="저장된 실험 사진" /><button type="button" onClick={() => { editVersion.current += 1; setExistingImages((current) => current.filter((item) => item.id !== image.id)); setDirty(true); }}>사진 제거</button></figure>)}
          {newPhotos.map((photo) => <figure className="journal-photo" key={photo.clientId}><img src={photo.previewUrl} alt="새 실험 사진 미리보기" /><button type="button" onClick={() => { editVersion.current += 1; URL.revokeObjectURL(photo.previewUrl); setNewPhotos((current) => current.filter((item) => item.clientId !== photo.clientId)); setDirty(true); }}>사진 제거</button></figure>)}
        </div>
        <div className="journal-save-bar"><span>{dirty ? "작성 중 · 서버 임시 저장 필요" : "서버 저장 내용"}</span><button className="button" type="button" onClick={save} disabled={busy || !ready || conflictServer !== undefined || baseVersion === undefined}>{busy ? "저장 중…" : "임시 저장"}</button></div>
      </div>
      <aside className="journal-history">
        <h2 className="section-heading">이전 일지</h2>
        {journals.map((journal) => <button className={`journal-history-item ${journal.sessionNumber === fields.sessionNumber ? "active" : ""}`} type="button" key={journal.id} onClick={() => openJournal(journal)}><b>{journal.sessionNumber}차시</b><span>{journal.date}</span><small>사진 {journal.images.length}장</small></button>)}
        {!journals.length ? <div className="empty-state">저장된 일지가 없습니다.</div> : null}
      </aside>
    </section>
  );
}
