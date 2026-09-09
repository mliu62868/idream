import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prisma } from '../../packages/main/src/server/lib/db';
import { env } from '../../packages/main/src/server/lib/env';
const C='c4f97ea8-418f-44af-999a-9dc02975e2d7', U='voice-audit-user-20260906';
const db=new URL(env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(db.hostname)||env.APP_ENV==='production') throw new Error('Local only');
const session=await prisma.session.findUniqueOrThrow({where:{id:U}});
const requests=await prisma.voiceClipRequest.findMany({where:{userId:U},include:{usageFacts:true},orderBy:{createdAt:'asc'}});
const deliveries=[];
for(const request of requests){
 const response=await fetch(`http://127.0.0.1:3000/api/v1/media/${request.mediaAssetId}/content`,{headers:{cookie:`idream_session=${session.token}; AdultContentAcceptedOD=true`}});
 const audio=new Uint8Array(await response.arrayBuffer());
 if(!response.ok||audio.length<1000)throw new Error(`Audio delivery failed: ${response.status}`);
 const tag=request.messageId.split('-').at(-1);
 await writeFile(`.scratch/voice-audit-20260906/${tag}.wav`,audio);
 deliveries.push({requestId:request.id,status:response.status,bytes:audio.length,contentType:response.headers.get('content-type'),sha256:createHash('sha256').update(audio).digest('hex')});
}
const character=await prisma.character.findUniqueOrThrow({where:{id:C},select:{id:true,voiceId:true,visibility:true,status:true}});
const profiles=await prisma.characterVoiceProfile.findMany({where:{characterId:C},select:{id:true,version:true,status:true,provider:true,providerVoiceId:true,createdAt:true,archivedAt:true}});
const defaults=await prisma.appSetting.findUnique({where:{key:'voice.defaults'}});
const audit=await prisma.adminAuditLog.findMany({where:{reason:{startsWith:'Voice audit:'}},select:{action:true,targetId:true,reason:true,createdAt:true},orderBy:{createdAt:'asc'}});
const report={checkedAt:new Date().toISOString(),character,profiles,defaults,requests,deliveries,audit,usageCount:requests.flatMap(r=>r.usageFacts).length,totalDurationMs:requests.flatMap(r=>r.usageFacts).reduce((a,f)=>a+f.durationMs,0)};
await writeFile('.scratch/voice-audit-20260906/final-live-evidence.json',JSON.stringify(report,null,2));
// Keep the private fixture's immutable voice evidence; retire it from operations
// and revoke this task's temporary login and allowances.
await prisma.$transaction([
 prisma.character.update({where:{id:C},data:{status:'archived'}}),
 prisma.user.update({where:{id:U},data:{dataClass:'audit',status:'suspended'}}),
 prisma.session.deleteMany({where:{userId:U}}),
 prisma.entitlement.deleteMany({where:{userId:U}}),
]);
console.log(JSON.stringify({deliveries,usageCount:report.usageCount,totalDurationMs:report.totalDurationMs,defaultsVersion:defaults?.version,cleanup:{characterStatus:'archived',userDataClass:'audit',userStatus:'suspended',sessions:await prisma.session.count({where:{userId:U}}),entitlements:await prisma.entitlement.count({where:{userId:U}})},preserved:'private fixture, archived profiles, media, audit evidence'}));
await prisma.$disconnect();
