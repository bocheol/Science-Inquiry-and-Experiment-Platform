export function LegacyDocumentDraft({ values, labels }: { values: Record<string, unknown>; labels: Record<string, string> }) {
  if (!Object.keys(values).length) return null;
  return <details className="notice-box"><summary>이전 버전에서 작성한 미저장 글 보기</summary>
    <p>어느 탐구 회차의 글인지 확인할 수 없어 현재 문서에 자동으로 넣지 않았습니다. 필요한 부분만 복사해 사용하세요. 원래 초안은 보관돼 있습니다.</p>
    {Object.entries(values).map(([key, value]) => <div key={key}><b>{labels[key] ?? key}</b><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{typeof value === "string" ? value : JSON.stringify(value)}</p></div>)}
  </details>;
}
