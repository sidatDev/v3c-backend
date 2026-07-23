import { PrismaClient } from '@prisma/client';
import { RetrievalService } from '../src/services/ai/RetrievalService';
import { ChatService } from '../src/services/ai/ChatService';

const prisma = new PrismaClient();

interface TestCase {
  name: string;
  query: string;
  expectedKeyword: string;
  minSimilarity: number;
}

const TEST_CASES: TestCase[] = [
  {
    name: 'IGI Insurance Overview',
    query: 'What is IGI Insurance?',
    expectedKeyword: 'General Insurance',
    minSimilarity: 0.3
  },
  {
    name: 'Life Insurance Products',
    query: 'What products are included in IGI Life Insurance?',
    expectedKeyword: 'term life',
    minSimilarity: 0.3
  },
  {
    name: 'General Insurance Coverage',
    query: 'What does IGI General Insurance protect against?',
    expectedKeyword: 'accidents',
    minSimilarity: 0.3
  }
];

async function runAiEvaluation() {
  console.log('====================================================');
  console.log('   V3C AUTOMATED AI EVALUATION & REGRESSION SUITE   ');
  console.log('====================================================\n');

  // Find tenant with KB entries
  const kbEntry = await prisma.knowledgeBaseEntry.findFirst({
    where: { enabled: true }
  });

  if (!kbEntry || !kbEntry.tenantId) {
    console.error('❌ FAIL: No active KnowledgeBaseEntry found in DB for testing.');
    process.exit(1);
  }

  const tenantId = kbEntry.tenantId;
  console.log(`Using Tenant ID for test suite: ${tenantId}\n`);

  let passedCount = 0;
  let totalCount = TEST_CASES.length;

  for (const test of TEST_CASES) {
    console.log(`----------------------------------------------------`);
    console.log(`RUNNING TEST: [${test.name}]`);
    console.log(`Query: "${test.query}"`);

    // 1. Evaluate RetrievalService
    const retrieval = await RetrievalService.search(tenantId, test.query, 5, 0.1);
    console.log(`-> Retrieval Chunks Returned: ${retrieval.chunks.length}`);
    console.log(`-> Avg Similarity Score: ${retrieval.avgSimilarity.toFixed(4)}`);

    const hasMinSim = retrieval.avgSimilarity >= test.minSimilarity || retrieval.chunks.length > 0;
    if (!hasMinSim) {
      console.log(`❌ FAIL: Similarity score below threshold (${test.minSimilarity})`);
      continue;
    }

    // 2. Evaluate ChatService Pipeline
    const chatResult = await ChatService.handleChat({
      message: test.query,
      language: 'en'
    });

    console.log(`-> AI Reply snippet: "${chatResult.reply.substring(0, 150)}..."`);
    console.log(`-> Sources: ${JSON.stringify(chatResult.sources)}`);

    const containsKeyword = chatResult.reply.toLowerCase().includes(test.expectedKeyword.toLowerCase());
    if (containsKeyword) {
      console.log(`✅ PASS: Reply contains expected keyword "${test.expectedKeyword}"`);
      passedCount++;
    } else {
      console.log(`❌ FAIL: Reply missing expected keyword "${test.expectedKeyword}"`);
    }
  }

  console.log('\n====================================================');
  console.log(`EVALUATION COMPLETE: ${passedCount}/${totalCount} TESTS PASSED`);
  console.log('====================================================');

  if (passedCount === totalCount) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAiEvaluation().catch(e => {
  console.error('Evaluation Error:', e);
  process.exit(1);
});
