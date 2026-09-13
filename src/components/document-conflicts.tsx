"use client";

function readable(value: unknown) {
  if (value == null || value === "") return "(빈 항목)";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function DocumentConflicts({ conflicts, labels, busy, onUseRemote, onKeepMine }: {
  conflicts: Array<{ key: string; mine: unknown; remote: unknown }>;
  labels: Record<string, string>;
  busy: boolean;
  onUseRemote: (key: string) => void;
  onKeepMine: (key: string) => Promise<void>;
}) {
  if (!conflicts.length) return null;
  return <section className="warning-box" aria-label="작성 내용 비교">
    <b>같은 항목의 공유 내용이 변경되었습니다.</b>
    <p>내 글은 현재 화면에 남아 있습니다. 두 내용을 비교한 뒤 임시 저장하세요.</p>
    {conflicts.map((item) => <div className="stack" key={item.key}>
      <strong>{labels[item.key] ?? "팀원 역할"}</strong>
      <label className="label">공유된 최신 내용<textarea className="textarea" readOnly value={readable(item.remote)} /></label>
      <label className="label">내 작성 내용<textarea className="textarea" readOnly value={readable(item.mine)} /></label>
      <div className="toolbar-group">
        <button className="button secondary" disabled={busy} onClick={() => {
          if (window.confirm("내 미저장 내용을 버리고 공유된 최신 내용을 사용할까요? 필요한 글은 먼저 복사해 주세요.")) onUseRemote(item.key);
        }}>공유 내용 사용</button>
        <button className="button secondary" disabled={busy} onClick={() => {
          if (window.confirm("내 작성 내용을 사용할까요? 선택 후 임시 저장을 눌러야 공유 내용에 반영됩니다.")) void onKeepMine(item.key);
        }}>비교 완료 · 내 내용 사용</button>
      </div>
    </div>)}
  </section>;
}
