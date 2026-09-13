"use client";

export function FormConflict({ rows, onResolve }: { rows: Array<{ label: string; mine: string; server: string }>; onResolve: (keepMine: boolean) => void }) {
  return <section className="warning-box stack" role="alert">
    <b>최신 저장 내용과 내 초안을 비교해 주세요.</b>
    <p>다른 곳에서 저장했거나, 이전 초안의 저장 기준을 확인할 수 없습니다. 내 초안은 유지되어 있습니다.</p>
    {rows.map((row, index) => <div key={index} className="stack"><b>{row.label}</b><div><small>최신 저장 내용</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.server || "(비어 있음)"}</p></div><div><small>내 작성 내용</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.mine || "(비어 있음)"}</p></div></div>)}
    <div className="toolbar-group"><button type="button" className="button secondary" onClick={() => onResolve(false)}>최신 저장 내용 사용</button><button type="button" className="button" onClick={() => onResolve(true)}>내 작성 내용으로 계속</button></div>
    <small>내 작성 내용으로 계속하면 저장 버튼을 눌러야 서버에 반영됩니다.</small>
  </section>;
}
