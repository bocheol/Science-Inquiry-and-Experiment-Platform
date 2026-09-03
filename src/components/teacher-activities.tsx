"use client";
import { useState } from 'react';
import { TeacherDashboard } from '@/components/teacher-dashboard';
import { ClubManager } from '@/components/club-manager';
import type { TeacherDashboardData } from '@/lib/teacher-data';
import type { getClubManagement } from '@/lib/clubs';

export function TeacherActivities({ classes, clubs }: { classes: TeacherDashboardData; clubs: Awaited<ReturnType<typeof getClubManagement>> }) {
  const [activity, setActivity] = useState<'class' | 'club'>('class');
  return <div className="stack">
    <nav className="activity-picker no-print" aria-label="관리할 활동">
      <button className={`button ${activity === 'class' ? '' : 'secondary'}`} aria-pressed={activity === 'class'} onClick={() => setActivity('class')}>과탐실</button>
      <button className={`button ${activity === 'club' ? '' : 'secondary'}`} aria-pressed={activity === 'club'} onClick={() => setActivity('club')}>동아리</button>
    </nav>
    <div hidden={activity !== 'class'}><TeacherDashboard initialData={classes} /></div>
    <div hidden={activity !== 'club'}><ClubManager initialData={clubs} /></div>
  </div>;
}
