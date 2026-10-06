import {NextResponse} from "next/server";
import {getCurrentUser} from "@/lib/auth";
import {getTeacherDashboardData} from "@/lib/teacher-data";
export const dynamic="force-dynamic";
export async function GET(){
  const headers={"Cache-Control":"no-store"};
  if(process.env.SITES_PILOT_ENABLED!=="true")return NextResponse.json({message:"실험용 API가 비활성화되어 있습니다."},{status:404,headers});
  const user=await getCurrentUser();
  if(!user||user.role!=="teacher"||user.mustChangePassword)return NextResponse.json({message:"교사 권한이 필요합니다."},{status:403,headers});
  const data=await getTeacherDashboardData();
  // Current dashboard scope is standard school accounts. Club summary is not inferred.
  return NextResponse.json({scope:"standard-school",counts:data.counts,teams:data.teams.map(t=>({id:t.id,name:t.name,classNumber:t.classNumber,memberCount:t.memberCount,messageCount:t.messageCount,journalEntryCount:t.journalEntryCount,planStatus:t.planStatus,lastActivityAt:t.lastActivityAt})),usage:{tokens:null,costUsd:null,credits:null,monthlyBudgetUsd:null}},{headers});
}
