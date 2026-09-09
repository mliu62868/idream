import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma } from '../../packages/main/src/server/lib/db';
import { env } from '../../packages/main/src/server/lib/env';
const C = 'c4f97ea8-418f-44af-999a-9dc02975e2d7';
const U = 'voice-audit-user-20260906';
const S = 'voice-audit-session-20260906';
const mode = process.argv[2] ?? 'inspect';
const db = new URL(env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(db.hostname) || env.APP_ENV === 'production') throw new Error('Controlled local database required');
if (mode === 'setup') {
  await prisma.user.create({data:{id:U,email:`${U}@example.invalid`,name:'Voice Audit 20260906',dataClass:'internal'}});
  await prisma.session.create({data:{id:U,userId:U,token:randomUUID(),expiresAt:new Date(Date.now()+3600000)}});
  await prisma.ageGateAcceptance.create({data:{userId:U,sourcePath:'voice-audit-20260906'}});
  await prisma.entitlement.createMany({data:[{userId:U,key:'voice_enabled',value:true,source:'admin'},{userId:U,key:'voice_minutes',value:1,source:'admin'}]});
  await prisma.character.update({where:{id:C},data:{creatorId:U}});
  await prisma.recentChat.create({data:{sessionId:S,userId:U,characterId:C}});
  console.log(JSON.stringify({mode,characterId:C,userId:U,db:{host:db.hostname,database:db.pathname},allowanceMs:60000}));
} else if (mode === 'clip') {
  const tag = process.argv[3];
  if (!['pocket','fish','default'].includes(tag)) throw new Error('Unknown test clip');
  const messageId = `${U}-${tag}`;
  const text = 'Hello. This is a short voice delivery test.';
  const prior = await prisma.chatTurn.findUnique({where:{assistantMessageId:messageId}});
  if (!prior) await prisma.chatTurn.create({data:{id:messageId,sessionId:S,idempotencyKey:messageId,requestHash:messageId,userMessageId:`${messageId}-user`,assistantMessageId:messageId,userContent:'Voice audit fixture',assistantContent:text,assistantStatus:'sent',memoryEnabled:false,terminalAt:new Date()}});
  const auth = await prisma.session.findUniqueOrThrow({where:{id:U}});
  const calls=[];
  for (let i=0;i<2;i++) {
    const start=Date.now();
    const response=await fetch('http://127.0.0.1:3000/api/v1/generation/voice',{method:'POST',headers:{'content-type':'application/json',cookie:`idream_session=${auth.token}; AdultContentAcceptedOD=true`},body:JSON.stringify({characterId:C,messageId,sessionId:S,text,intent:'play'}),signal:AbortSignal.timeout(120000)});
    const body=await response.json();
    calls.push({status:response.status,elapsedMs:Date.now()-start,body});
    if (!response.ok || !body.ok) throw new Error(JSON.stringify(calls));
  }
  const request=await prisma.voiceClipRequest.findUniqueOrThrow({where:{userId_messageId:{userId:U,messageId}},include:{usageFacts:true,mediaAsset:true}});
  const usage=await prisma.voiceUsageFact.aggregate({where:{userId:U},_sum:{durationMs:true,costDreamcoins:true}});
  const report={tag,calls,request,allowanceRemainingMs:60000-(usage._sum.durationMs??0),totalCostDreamcoins:usage._sum.costDreamcoins??0};
  await writeFile(`.scratch/voice-audit-20260906/live-${tag}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({tag,calls:calls.map(c=>({status:c.status,elapsedMs:c.elapsedMs})),requestId:request.id,provider:request.provider,providerPayload:request.providerPayload,status:request.status,attempt:request.attemptNo,usage:request.usageFacts,allowanceRemainingMs:report.allowanceRemainingMs}));
} else {
 const character=await prisma.character.findUnique({where:{id:C},select:{id:true,name:true,voiceId:true,status:true,visibility:true}});
 const profiles=await prisma.characterVoiceProfile.findMany({where:{characterId:C},include:{previewAsset:true,referenceAsset:true},orderBy:{version:'asc'}});
 await writeFile('.scratch/voice-audit-20260906/profiles.json',JSON.stringify({character,profiles},null,2));
 console.log(JSON.stringify({character,profiles:profiles.map(p=>({id:p.id,provider:p.provider,status:p.status,version:p.version,providerVoiceId:p.providerVoiceId,preview:p.previewAsset?.url}))}));
}
await prisma.$disconnect();
