"use client";
import { useState } from 'react';
import { TeacherDashboard } from '@/components/teacher-dashboard';
import { ClubManager } from '@/components/club-manager';
import type { TeacherDashboardData } from '@/lib/teacher-data';
import type { getClubManagement } from '@/lib/clubs';

export function TeacherActivities({ classes, clubs, classSheetUrl }: { classes: TeacherDashboardData; clubs: Awaited<ReturnType<typeof getClubManagement>>; classSheetUrl: string | null }) {
  const [activity, setActivity] = useState<'class' | 'club'>('class');
  return <div className="stack">
    <nav className="activity-picker no-print" aria-label="관리할 활동">
      <button className={`button ${activity === 'class' ? '' : 'secondary'}`} aria-pressed={activity === 'class'} onClick={() => setActivity('class')}>과탐실</button>
      <button className={`button ${activity === 'club' ? '' : 'secondary'}`} aria-pressed={activity === 'club'} onClick={() => setActivity('club')}>동아리</button>
    </nav>
    <div hidden={activity !== 'class'} className="stack">
      <section className="card card-body no-print" aria-label="과탐실 준비물 시트">
        <div className="toolbar">
          <div><h2 className="section-heading">준비물 신청 현황</h2><p className="section-subtitle">Google 스프레드시트에서 반별 신청 내용을 확인합니다. 시트 접근 권한이 있는 Google 계정으로 열어 주세요.</p></div>
          {classSheetUrl ? <a className="button secondary" href={classSheetUrl} target="_blank" rel="noopener noreferrer">준비물 시트 열기 ↗<span className="sr-only"> (새 탭)</span></a> : <span className="badge">준비물 시트 미설정</span>}
        </div>
      </section>
      <TeacherDashboard initialData={classes} />
    </div>
    <div hidden={activity !== 'club'}><ClubManager initialData={clubs} /></div>
  </div>;
}
