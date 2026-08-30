"use client";

import { useMemo, useRef, useState } from "react";
import { MATERIAL_BUDGET_WON } from "@/lib/constants";
import type { InquiryData } from "@/lib/inquiry-data";
import { normalizeMaterialLink } from "@/lib/material-links";
import type { MaterialItem } from "@/lib/types";
import { useToast } from "@/components/toast-provider";

const blankItem = (): MaterialItem => ({ name: "", specification: "", unitPrice: 0, quantity: 1, shipping: 0, link: "" });

export function MaterialForm({ data, onRefresh }: { data: InquiryData; onRefresh: () => Promise<void> }) {
  const { showToast } = useToast();
  const [items, setItems] = useState<MaterialItem[]>(data.materials?.items.length ? data.materials.items : [blankItem()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submissionId = useRef(typeof crypto !== "undefined" ? crypto.randomUUID() : `${Date.now()}-material`);
  const total = useMemo(() => items.reduce((sum, item) => sum + item.unitPrice * item.quantity + item.shipping, 0), [items]);
  const leader = data.members.find((member) => member.isLeader);

  function update(index: number, key: keyof MaterialItem, value: string) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? {
      ...item,
      [key]: key === "unitPrice" || key === "quantity" || key === "shipping" ? Math.max(0, Number(value) || 0) : value,
    } : item));
  }

  function normalizeLink(index: number) {
    setError("");
    setNotice("");
    const result = normalizeMaterialLink(items[index]?.link ?? "");
    if (!result.ok) {
      setError(`${index + 1}번째 품목: ${result.message}`);
      return false;
    }
    if (result.link !== items[index]?.link) update(index, "link", result.link);
    if (result.converted && result.link) setNotice(`${index + 1}번째 품목의 공유 링크를 PC용 주소로 정리했습니다.`);
    return true;
  }

  async function submit() {
    setError(""); setNotice("");
    const normalizedItems: MaterialItem[] = [];
    for (const [index, item] of items.entries()) {
      const result = normalizeMaterialLink(item.link);
      if (!result.ok) {
        setError(`${index + 1}번째 품목: ${result.message}`);
        return;
      }
      normalizedItems.push({ ...item, link: result.link });
    }
    setItems(normalizedItems);
    setBusy(true);
    const response = await fetch("/api/inquiry/materials", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionId: submissionId.current, sessionId: data.session.id, items: normalizedItems }),
    });
    const result = (await response.json()) as { message?: string; syncStatus?: string; syncError?: string };
    setBusy(false);
    if (!response.ok) {
      const message = result.message ?? "준비물을 저장하지 못했습니다.";
      setError(message);
      showToast(message, "error");
      return;
    }
    setNotice(result.syncStatus === "synced" ? "Google Sheet에 반영했습니다." : "플랫폼에 저장했습니다. Google Sheet 연결 후 자동 또는 교사 재전송이 필요합니다.");
    showToast("준비물이 신청되었습니다.");
    await onRefresh();
  }

  return (
    <section className="card">
      <div className="card-body">
        <div className="page-title" style={{ marginBottom: 12 }}><div><h1 style={{ fontSize: 26 }}>준비물 신청</h1><p>Google Sheet와 같은 열 순서로 입력합니다. 같은 품목도 다른 팀과 합치지 않습니다.</p></div>{data.materials ? <span className={`badge ${data.materials.syncStatus === "failed" ? "feedback" : ""}`}>{data.materials.syncStatus === "synced" ? "시트 반영됨" : data.materials.syncStatus === "failed" ? "전송 실패" : "전송 대기"}</span> : null}</div>
        <div className="notice-box"><b>자동 입력:</b> {data.team.teamNumber}조 · 팀장 학번/이름 {leader ? `${leader.loginId} ${leader.name}` : "(선생님 지정 필요)"}</div>
        <div className="notice-box"><b>상품 링크:</b> 모바일 쇼핑 앱의 공유 문구 전체를 붙여넣어도 됩니다. 지원 쇼핑몰의 모바일 주소는 PC용 주소로 자동 변환하며, 변환할 수 없는 모바일 전용 주소는 제출 전에 알려드립니다.</div>
        {total > MATERIAL_BUDGET_WON ? <div className="warning-box"><b>예산 초과</b> — 5만원을 넘었지만 제출할 수 있습니다. 선생님 승인이 필요합니다.</div> : null}
        {error ? <div className="error-box">{error}</div> : null}
        {notice ? <div className="notice-box">{notice}</div> : null}
      </div>
      <div className="table-wrap">
        <table className="material-table">
          <thead><tr><th>품명</th><th>규격(선택옵션)</th><th>단가</th><th>갯수</th><th>배송비</th><th>총액</th><th>링크</th><th></th></tr></thead>
          <tbody>{items.map((item, index) => <tr key={index}>
            <td><input className="input" value={item.name} onChange={(event) => update(index, "name", event.target.value)} placeholder="품명" /></td>
            <td><input className="input" value={item.specification} onChange={(event) => update(index, "specification", event.target.value)} placeholder="규격/옵션" /></td>
            <td><input className="input" type="number" min={0} value={item.unitPrice} onChange={(event) => update(index, "unitPrice", event.target.value)} /></td>
            <td><input className="input" type="number" min={1} value={item.quantity} onChange={(event) => update(index, "quantity", event.target.value)} /></td>
            <td><input className="input" type="number" min={0} value={item.shipping} onChange={(event) => update(index, "shipping", event.target.value)} /></td>
            <td><b>{(item.unitPrice * item.quantity + item.shipping).toLocaleString()}원</b></td>
            <td><input className="input" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" value={item.link} onChange={(event) => update(index, "link", event.target.value)} onBlur={() => normalizeLink(index)} placeholder="공유 문구 또는 https://" aria-label={`${index + 1}번째 품목 링크`} /></td>
            <td><button className="button ghost" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={items.length === 1}>삭제</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="material-summary"><button className="button ghost" onClick={() => setItems((current) => [...current, blankItem()])} disabled={items.length >= 20}>+ 품목 추가</button><span>조별 합계</span><span className="material-total">{total.toLocaleString()}원</span><button className="button" onClick={submit} disabled={busy || !items.every((item) => item.name.trim())}>{busy ? "저장 중…" : "준비물 제출"}</button></div>
    </section>
  );
}
