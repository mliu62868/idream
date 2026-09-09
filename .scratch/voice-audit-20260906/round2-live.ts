import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma } from '../../packages/main/src/server/lib/db';
import { env } from '../../packages/main/src/server/lib/env';
const C='c4f97ea8-418f-44af-999a-9dc02975e2d7', U='voice-audit-user-20260906', S='voice-audit-session-20260906', authId='voice-audit-round2-20260906';
const db=new URL(env.DATABASE_URL);
assert(['localhost','127.0.0.1'].includes(db.hostname) && db.pathname==='/idream_runtime_20260812' && env.APP_ENV!=='production');
const beforeCharacter=await prisma.character.findUniqueOrThrow({where:{id:C}});
const beforeUser=await prisma.user.findUniqueOrThrow({where:{id:U}});
assert.equal(beforeCharacter.name,'Voice Audit Iris 20260906');
assert.equal(beforeCharacter.creatorId,U);
assert.equal(beforeCharacter.voiceId,null);
assert.equal(await prisma.session.count({where:{userId:U}}),0);
assert.equal(await prisma.entitlement.count({where:{userId:U}}),0);
const beforeUsage=await prisma.voiceUsageFact.count({where:{userId:U}});
const defaultsBefore=await prisma.appSetting.findUniqueOrThrow({where:{key:'voice.defaults'}});
const originalFish=await prisma.voiceClipRequest.findUniqueOrThrow({where:{userId_messageId:{userId:U,messageId:`${U}-fish`}}});
const fishProfile=await prisma.characterVoiceProfile.findFirstOrThrow({where:{characterId:C,provider:'fish_audio',version:2}});
assert.equal(fishProfile.status,'archived');
const token=randomUUID();
const cookie=`idream_session=${token}; AdultContentAcceptedOD=true`;
const messageId=`${U}-round2-${Date.now()}`;
const text='Hello. My voice stays consistent while settings change.';
const fishMessageId=`${messageId}-fish`;
const calls:unknown[]=[];
let evidence:unknown;
try {
 await prisma.$transaction([
  prisma.character.update({where:{id:C},data:{status:'draft'}}),
  prisma.user.update({where:{id:U},data:{status:'active',dataClass:'internal'}}),
  prisma.session.create({data:{id:authId,userId:U,token,expiresAt:new Date(Date.now()+1800000)}}),
  prisma.entitlement.createMany({data:[{userId:U,key:'voice_enabled',value:true,source:'admin'},{userId:U,key:'voice_minutes',value:1,source:'admin'}]}),
  prisma.chatTurn.create({data:{id:messageId,sessionId:S,idempotencyKey:messageId,requestHash:messageId,userMessageId:`${messageId}-user`,assistantMessageId:messageId,userContent:'Controlled round 2 voice audit',assistantContent:text,assistantStatus:'sent',memoryEnabled:false,terminalAt:new Date()}}),
 ]);
 await prisma.chatTurn.create({data:{id:fishMessageId,sessionId:S,idempotencyKey:fishMessageId,requestHash:fishMessageId,userMessageId:`${fishMessageId}-user`,assistantMessageId:fishMessageId,userContent:'Controlled round 2 pinned Fish voice audit',assistantContent:text,assistantStatus:'sent',memoryEnabled:false,terminalAt:new Date()}});
 for(const [id,spoken,status] of [[messageId,text,201],[messageId,text,200],[fishMessageId,text,201],[fishMessageId,text,200],[`${U}-fish`,'Hello. This is a short voice delivery test.',200]] as const){
  if(id===fishMessageId){
   const activate=status===201;
   // Only this task's private archived fixture is temporarily restored for synthesis.
   await prisma.$transaction([
    prisma.character.update({where:{id:C},data:{voiceId:activate?fishProfile.providerVoiceId:null}}),
    prisma.characterVoiceProfile.update({where:{id:fishProfile.id},data:{status:activate?'active':fishProfile.status,archivedAt:activate?null:fishProfile.archivedAt}}),
   ]);
  }
  const started=Date.now();
  const response=await fetch('http://127.0.0.1:3000/api/v1/generation/voice',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({characterId:C,messageId:id,sessionId:S,text:spoken,intent:'play'}),signal:AbortSignal.timeout(60000)});
  const body=await response.json();
  calls.push({messageId:id,status:response.status,elapsedMs:Date.now()-started,body});
  assert.equal(response.status,status,JSON.stringify(body));
 }
 const request=await prisma.voiceClipRequest.findUniqueOrThrow({where:{userId_messageId:{userId:U,messageId}},include:{usageFacts:true}});
 assert.equal(request.provider,'pocket_tts');
 assert.equal(request.providerPayload?.['voiceAuthority'],'system_default');
 assert.equal(request.providerPayload?.['systemVoiceSettingVersion'],defaultsBefore.version);
 assert.equal(request.usageFacts.length,1);
 assert.equal(await prisma.voiceUsageFact.count({where:{userId:U}}),beforeUsage+2);
 const fishRequest=await prisma.voiceClipRequest.findUniqueOrThrow({where:{userId_messageId:{userId:U,messageId:fishMessageId}},include:{usageFacts:true}});
 assert.equal(fishRequest.provider,'fish_audio');
 assert.equal(fishRequest.providerPayload?.['voiceId'],fishProfile.providerVoiceId);
 assert.equal(fishRequest.providerPayload?.['characterVoiceProfileVersion'],2);
 assert.equal(fishRequest.usageFacts.length,1);
 const replayedFish=await prisma.voiceClipRequest.findUniqueOrThrow({where:{id:originalFish.id}});
 assert.equal(replayedFish.mediaAssetId,originalFish.mediaAssetId);
 assert.deepEqual(replayedFish.providerPayload,originalFish.providerPayload);
 const media=await fetch(`http://127.0.0.1:3000/api/v1/media/${request.mediaAssetId}/content`,{headers:{cookie},signal:AbortSignal.timeout(10000)});
 const bytes=new Uint8Array(await media.arrayBuffer());
 assert.equal(media.status,200);
 assert(bytes.length>1000);
 await writeFile('.scratch/voice-audit-20260906/round2-default.wav',bytes);
 const fishMedia=await fetch(`http://127.0.0.1:3000/api/v1/media/${fishRequest.mediaAssetId}/content`,{headers:{cookie},signal:AbortSignal.timeout(10000)});
 const fishBytes=new Uint8Array(await fishMedia.arrayBuffer());
 assert.equal(fishMedia.status,200);assert(fishBytes.length>1000);
 await writeFile('.scratch/voice-audit-20260906/round2-fish.wav',fishBytes);
 const defaultsAfter=await prisma.appSetting.findUniqueOrThrow({where:{key:'voice.defaults'}});
 assert.equal(defaultsAfter.version,defaultsBefore.version);
 assert.deepEqual(defaultsAfter.value,defaultsBefore.value);
 evidence={checkedAt:new Date().toISOString(),calls,request,fishRequest,fishDelivery:{status:fishMedia.status,bytes:fishBytes.length,contentType:fishMedia.headers.get('content-type'),sha256:createHash('sha256').update(fishBytes).digest('hex')},delivery:{status:media.status,bytes:bytes.length,contentType:media.headers.get('content-type'),sha256:createHash('sha256').update(bytes).digest('hex')},replayedFish:{requestId:originalFish.id,mediaAssetId:replayedFish.mediaAssetId,providerPayload:replayedFish.providerPayload},newUsageFacts:2,defaultsVersion:defaultsAfter.version};
} finally {
 await prisma.$transaction([
  prisma.character.update({where:{id:C},data:{status:beforeCharacter.status,voiceId:beforeCharacter.voiceId}}),
  prisma.characterVoiceProfile.update({where:{id:fishProfile.id},data:{status:fishProfile.status,archivedAt:fishProfile.archivedAt}}),
  prisma.user.update({where:{id:U},data:{status:beforeUser.status,dataClass:beforeUser.dataClass}}),
  prisma.session.deleteMany({where:{userId:U,id:authId}}),
  prisma.entitlement.deleteMany({where:{userId:U}}),
 ]);
 const cleanup={sessions:await prisma.session.count({where:{userId:U}}),entitlements:await prisma.entitlement.count({where:{userId:U}}),characterStatus:beforeCharacter.status,userStatus:beforeUser.status};
 await writeFile('.scratch/voice-audit-20260906/round2-live-evidence.json',JSON.stringify({evidence,calls,cleanup},null,2));
 console.log(JSON.stringify({evidence,calls,cleanup}));
 await prisma.$disconnect();
}
