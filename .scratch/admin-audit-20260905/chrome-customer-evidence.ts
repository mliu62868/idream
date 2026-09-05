import { prisma } from '../../packages/main/src/server/lib/db';
const target=new URL(process.env.DATABASE_URL!);
if(!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/idream_runtime_20260812')throw Error('Unexpected runtime DB');
const user=await prisma.user.findUniqueOrThrow({where:{email:'chrome-admin-e2e-20260905@example.invalid'},select:{id:true,dataClass:true}});
if(process.argv.includes('--classify')) await prisma.user.update({where:{id:user.id},data:{dataClass:'audit'}});
console.log(JSON.stringify({user,usage:await prisma.chatTurnUsageFact.findMany({where:{userId:user.id}}),turns:await prisma.chatTurn.findMany({where:{session:{userId:user.id}},select:{id:true,sessionId:true,attempt:true,userContent:true,assistantContent:true,assistantStatus:true,model:true,promptTokens:true,completionTokens:true,terminalEvidence:true,characterReleaseId:true,createdAt:true,terminalAt:true}})},null,2));
await prisma.$disconnect();
