import prisma from '../src/lib/prisma';

async function main() {
  const tenantId = '1b91bbeb-a5a2-4b9b-ba6a-094a01445bed';
  
  const kb = await prisma.knowledgeBaseEntry.findFirst({
    where: { tenantId }
  });
  console.log('KB Entry Title:', kb?.title);
  console.log('KB Entry Content (truncated):', kb?.content?.substring(0, 500));

  const chunks = await prisma.documentChunk.findMany({
    where: { tenantId }
  });
  console.log('DocumentChunks found:', chunks.length);
  chunks.forEach((c, idx) => {
    console.log(`Chunk ${idx + 1} Content:`, c.content);
  });
}

main().catch(e => console.error(e));
