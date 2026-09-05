import { randomUUID } from 'node:crypto';
const { prisma } = await import('../../packages/main/src/server/lib/db');
const { selectCharacterDraftImage } = await import('../../packages/main/src/server/modules/admin-v2/characters/asset-studio');
const { createCharacterRelease } = await import('../../packages/main/src/server/modules/admin-v2/characters/release-lifecycle');
const { transitionCharacterRelease } = await import('../../packages/main/src/server/modules/admin-v2/characters/transition');
const { publishCharacterReferenceSet } = await import('../../packages/main/src/server/modules/admin-v2/characters/reference-set');
const target = new URL(process.env.DATABASE_URL!);
if (target.hostname !== 'localhost' || target.pathname !== '/idream_test') throw Error('Unexpected database');
const results: unknown[]=[];
const marker = new Error('ROLLBACK_AUDIT_FIXTURE');
const suffix=randomUUID();
const id=(part:string)=>`admin-audit-${part}-${suffix}`;
try {
 await prisma.$transaction(async (tx:any)=>{
 const actor={id:id('actor'),role:'admin',permissions:[]};
 const characterId=id('character'),projectId=id('project'),contentId=id('content'),revisionId=id('revision'),releaseId=id('release');
 await tx.user.create({data:{id:actor.id,email:`${actor.id}@idream.internal`,role:'admin',status:'active'}});
 await tx.character.create({data:{id:characterId,creatorId:actor.id,name:'Audit rollback-only fixture',age:24,description:'Recovery probe',visibility:'private',status:'draft',appearance:{},advancedDetails:{}}});
 await tx.characterContentVersion.create({data:{id:contentId,characterId,version:1,contentHash:contentId,personaSnapshot:{},openingSnapshot:{},appearanceSnapshot:{},sourceType:'test',createdById:actor.id}});
 await tx.characterProject.create({data:{id:projectId,characterId}});
 await tx.characterRevision.create({data:{id:revisionId,projectId,revision:1,characterContentVersionId:contentId,projectSnapshot:{},createdById:actor.id}});
 await tx.characterRelease.create({data:{id:releaseId,projectId,revisionId,characterContentVersionId:contentId,generationProvenance:{},releasePlacementManifest:{},snapshotHash:id('snapshot'),status:'approved'}});
 const check=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();results.push({name,unexpectedSuccess:true});}catch(e:any){results.push({name,status:e.status,message:e.message});}};
 await check('replace image',()=>selectCharacterDraftImage({characterId,expectedProjectVersion:1,purpose:'character_cover',assetId:id('new-asset'),actor,reason:'Audit',requestId:id('request')},tx));
 await check('prepare replacement release',()=>createCharacterRelease({request:new Request('http://localhost/audit'),characterId,expectedProjectVersion:1,reason:'Audit',actor},tx));
 await check('withdraw approved release',()=>transitionCharacterRelease(tx,{releaseId,to:'withdrawn',expectedVersion:1}));
 await check('supersede approved release',()=>transitionCharacterRelease(tx,{releaseId,to:'superseded',expectedVersion:1}));
 await check('replace reference set',()=>publishCharacterReferenceSet({tx,characterId,actor,requestId:id('references'),request:{confirmation:`PUBLISH REFERENCES ${characterId}`,visualProfileId:id('profile'),references:[{mediaAssetId:id('reference'),role:'identity_anchor'}],expectedActiveReferenceSetRevisionId:null,expectedActiveReferenceSetRevision:0,reason:'Audit'} as any}));
 const row=await tx.characterRelease.findUnique({where:{id:releaseId}});
 results.push({name:'final candidate state',status:row.status,version:row.version});
 throw marker;
 },{timeout:15000});
} catch(e) {if(e!==marker) throw e;} finally {await prisma.$disconnect();}
console.log(JSON.stringify({database:target.pathname,fixtureRolledBack:true,results},null,2));
if(results.some((r:any)=>r.unexpectedSuccess)) process.exitCode=1;
