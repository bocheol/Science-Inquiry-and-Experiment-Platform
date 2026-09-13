"use client";

import { useEffect, useState } from "react";
import type { ExperimentJournal } from "@/lib/types";
import { TeacherJournalReview } from "@/components/teacher-journal-review";

function StudentHistory({sessionId, cycleId}: {sessionId:string; cycleId:string}) {
  const [journals,setJournals]=useState<ExperimentJournal[] | null>(null);
  const [error,setError]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{
      try {
        const response=await fetch(`/api/inquiry/journals?sessionId=${encodeURIComponent(sessionId)}&cycleId=${encodeURIComponent(cycleId)}`,{cache:"no-store",signal:controller.signal});
        const result=await response.json() as {journals?:ExperimentJournal[];message?:string};
        if(!response.ok) throw new Error(result.message??"일지를 불러오지 못했습니다.");
        if(!controller.signal.aborted) setJournals(result.journals??[]);
      } catch(error) {if(!controller.signal.aborted) setError(error instanceof Error?error.message:"일지 응답을 확인하지 못했습니다.");}
    })();
    return ()=>controller.abort();
  },[sessionId,cycleId]);
  return <div className="stack"><p className="section-subtitle">이 회차에 내가 저장한 일지입니다. 완료된 기록은 수정할 수 없습니다.</p>
    {error?<div className="error-box">{error}</div>:journals===null?<p>일지를 불러오는 중입니다…</p>:journals.length===0?<p>이 회차에 저장한 일지가 없습니다.</p>:journals.map(journal=><article className="journal-read-card" key={journal.id}>
      <div className="toolbar"><h3>{journal.sessionNumber}차시</h3><span>{journal.date}</span></div>
      <dl><dt>오늘 한 일</dt><dd>{journal.activities}</dd><dt>관찰 결과</dt><dd>{journal.observations}</dd><dt>느낀 점 / 궁금한 점</dt><dd>{journal.reflections||"작성 없음"}</dd></dl>
      <div className="journal-photo-grid">{journal.images.map(image=><a href={image.url} target="_blank" rel="noreferrer" key={image.id}><img src={image.url} alt={`${journal.sessionNumber}차시 실험 사진`}/></a>)}</div>
    </article>)}
  </div>;
}

export function PastCycleJournals({sessionId,teamId,cycleId,audience}:{sessionId:string;teamId:string;cycleId:string;audience:"student"|"teacher"}) {
  const [open,setOpen]=useState(false);
  return <details className="cycle-document" onToggle={event=>setOpen(event.currentTarget.open)}><summary><strong>{audience==="teacher"?"이 회차의 개인 일지와 사진":"이 회차의 내 일지와 사진"}</strong></summary>
    {open?(audience==="teacher"?<TeacherJournalReview key={cycleId} teamId={teamId} cycleId={cycleId}/>:<StudentHistory key={cycleId} sessionId={sessionId} cycleId={cycleId}/>):null}
  </details>;
}
