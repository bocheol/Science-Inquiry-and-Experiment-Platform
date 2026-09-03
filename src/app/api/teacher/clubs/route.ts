import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assignClubStudent, createClub, createClubTeam, enrollClubStudent, getClubManagement, leaveClub } from "@/lib/clubs";
const schema=z.discriminatedUnion("action",[
  z.object({action:z.literal("create"),name:z.string().min(1).max(60)}),
  z.object({action:z.literal("team"),clubId:z.string(),name:z.string().min(1).max(60)}),
  z.object({action:z.literal("enroll"),clubId:z.string(),loginId:z.string().max(5),name:z.string().max(80)}),
  z.object({action:z.literal("assign"),clubId:z.string(),studentId:z.string(),teamId:z.string(),leader:z.boolean()}),
  z.object({action:z.literal("leave"),clubId:z.string(),studentId:z.string()}),
]);
export async function GET(){const actor=await getCurrentUser();if(!actor||actor.role!=="teacher"||actor.mustChangePassword)return Response.json({message:"권한이 없습니다."},{status:403});return Response.json(await getClubManagement(actor.id));}
export async function POST(request:Request){
  const actor=await getCurrentUser();if(!actor||actor.role!=="teacher"||actor.mustChangePassword)return Response.json({message:"권한이 없습니다."},{status:403});
  const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return Response.json({message:"입력 내용을 확인해 주세요."},{status:400});
  const input=parsed.data;
  try{
    if(input.action==='create')await createClub(actor.id,input.name);
    if(input.action==='team')await createClubTeam(actor.id,input.clubId,input.name);
    if(input.action==='enroll')return Response.json({ok:true,credential:await enrollClubStudent(actor.id,input.clubId,input.loginId,input.name)});
    if(input.action==='assign')await assignClubStudent(actor.id,input.clubId,input.studentId,input.teamId,input.leader);
    if(input.action==='leave')await leaveClub(actor.id,input.clubId,input.studentId);
    return Response.json({ok:true});
  }catch(error){return Response.json({message:error instanceof Error && !('code' in error)?error.message:"처리하지 못했습니다. 중복된 등록인지 확인해 주세요."},{status:400});}
}
