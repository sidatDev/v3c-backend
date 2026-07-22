import prisma from '../src/lib/prisma';

async function main() {
  const dcGroups = await prisma.documentChunk.groupBy({
    by: ['tenantId'],
    _count: { id: true }
  });
  console.log('DocumentChunk counts per Tenant:', JSON.stringify(dcGroups, null, 2));

  const kbeGroups = await prisma.knowledgeBaseEntry.groupBy({
    by: ['tenantId'],
    _count: { id: true }
  });
  console.log('KnowledgeBaseEntry counts per Tenant:', JSON.stringify(kbeGroups, null, 2));

  const activeAgents = await prisma.agent.findMany({
    select: { id: true, name: true, tenantId: true }
  });
  console.log('Active Agents:', JSON.stringify(activeAgents, null, 2));
}

main().catch(e => console.error(e));
