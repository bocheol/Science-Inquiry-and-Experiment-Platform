import {NextResponse} from "next/server";
import {getCurrentUser} from "@/lib/auth";
export const dynamic="force-dynamic";
/** Opt-in read adapter; no replacement authentication or database migration. */
export async function GET(){
  const headers={"Cache-Control":"no-store"};
  if(process.env.SITES_PILOT_ENABLED!=="true")return NextResponse.json({message:"실험용 API가 비활성화되어 있습니다."},{status:404,headers});
  const user=await getCurrentUser();
  if(!user)return NextResponse.json({message:"로그인이 필요합니다."},{status:401,headers});
  return NextResponse.json({user:{id:user.id,name:user.name,role:user.role,classNumber:user.classNumber,mustChangePassword:user.mustChangePassword},capabilities:{ai:false,credits:false,monthlyBudget:false,pdf:false,journalImages:true}},{headers});
}
