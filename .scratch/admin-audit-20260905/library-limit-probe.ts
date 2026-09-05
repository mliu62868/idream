import { randomUUID } from 'node:crypto';
const {prisma}=await import('../../packages/main/src/server/lib/db');
const {listCharacterImageSources}=await import('../../packages/main/src/server/modules/admin-v2/characters/image-sources');
const target=new URL(process.env.DATABASE_URL!);
if(target.hostname!=='localhost'||target.pathname!=='/idream_test')throw Error('Unexpected database');
const marker=new Error('ROLLBACK_AUDIT_FIXTURE');
const results:any[]=[];
const suffix=randomUUID(), actorId=`library-actor-${suffix}`, characterId=`library-character-${suffix}`;
try{await prisma.$transaction(async(tx:any)=>{
await tx.user.create({data:{id:actorId,email:`${actorId}@idream.internal`,role:'admin',status:'active',dataClass:'internal'}});
await tx.character.create({data:{id:characterId,creatorId:actorId,name:'Library limit probe',age:24,description:'rollback-only',source:'official',visibility:'private',status:'draft',appearance:{},advancedDetails:{}}});
const rows=Array.from({length:101},(_,i)=>({id:`library-asset-${i}-${suffix}`,ownerId:actorId,characterId,type:'image',url:`/user-content/audit/${i}.png`,storageKey:`audit/${i}.png`,contentType:'image/png',width:1,height:1,visibility:'private',safetyStatus:'passed',createdAt:new Date(Date.UTC(2026,0,1,0,0,i)),metadata:{purpose:'character_library',platformAsset:{purpose:'character_library',status:'draft'}}}));
await tx.mediaAsset.createMany({data:rows});
// The production function owns a global client. Bind only its read delegates to
// this real PostgreSQL transaction so uncommitted fixtures remain rollback-only.
const calls=[['character','findFirst'],['mediaAsset','findMany'],['contentProductionItem','findMany'],['creativeReviewDecision','findMany'],['characterVisualProfile','findFirst'],['characterProject','findFirst']] as const;
const originals=calls.map(([model,method])=>(prisma as any)[model][method]);
for(const [model,method] of calls)(prisma as any)[model][method]=tx[model][method].bind(tx[model]);
try{
let list=await listCharacterImageSources({characterId,purpose:'character_library'});
results.push({case:'101 available assets',databaseCount:101,returnedCount:list.items.length,oldestAssetPresent:list.items.some((a:any)=>a.id===rows[0].id)});
await tx.mediaAsset.updateMany({where:{id:{in:rows.slice(1).map(a=>a.id)}},data:{metadata:{purpose:'character_library',platformAsset:{purpose:'character_library',status:'archived'}}}});
list=await listCharacterImageSources({characterId,purpose:'character_library'});
results.push({case:'newest 100 archived; oldest still available',databaseAvailableCount:1,returnedCount:list.items.length});
}finally{calls.forEach(([model,method],i)=>{(prisma as any)[model][method]=originals[i];});}
throw marker;
},{timeout:15000});}catch(e){if(e!==marker)throw e;}finally{await prisma.$disconnect();}
console.log(JSON.stringify({database:target.pathname,fixtureRolledBack:true,realServiceWithTransactionBoundReadDelegates:true,results},null,2));
