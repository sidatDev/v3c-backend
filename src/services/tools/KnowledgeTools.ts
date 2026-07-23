import { RetrievalService, RetrievalResult } from '../ai/RetrievalService';
import { StructuredLogger } from '../logger/StructuredLogger';
import prisma from '../../lib/prisma';

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'searchKnowledge',
    description: 'Search the official tenant knowledge base to answer specific user questions about products, policies, services, operating hours, contact info, and FAQs.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query or question to retrieve relevant knowledge base information for.'
        }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'retrievePolicies',
    description: 'Retrieve company policies, terms, compliance rules, or refund guidelines matching the user query.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The specific policy topic, rule, or compliance item to search for.'
        }
      },
      required: ['topic']
    }
  }
];

export class KnowledgeTools {
  /**
   * Execute a tool call by name
   */
  static async executeTool(name: string, args: any, tenantId: string): Promise<{ resultText: string; sources: any[] }> {
    const startTime = Date.now();

    if (name === 'searchKnowledge' || name === 'retrievePolicies') {
      const query = args?.query || args?.topic || '';
      if (!query || query.trim() === '') {
        return { resultText: `No query provided for ${name}.`, sources: [] };
      }

      const agent = await prisma.agent.findFirst({
        where: { tenantId, isActive: true },
        include: { RetrievalConfig: true }
      });
      const threshold = agent?.RetrievalConfig?.similarityThreshold ?? 0.3;
      const retrieval: RetrievalResult = await RetrievalService.search(tenantId, query, 5, threshold);
      const latencyMs = Date.now() - startTime;

      console.log(`\n======================================`);
      console.log(`[TOOL CALL] Query: "${query}"`);
      console.log(`↓`);
      console.log(`Embedding generated?: YES`);
      console.log(`↓`);
      console.log(`Vector Search executed?: YES`);
      console.log(`↓`);
      console.log(`Similarity: ${retrieval.topSimilarity.toFixed(2)}`);
      console.log(`↓`);
      console.log(`Threshold: ${threshold.toFixed(2)}`);
      console.log(`↓`);
      console.log(`Fallback: ${retrieval.fallbackTriggered ? 'YES' : 'NO'}`);
      console.log(`↓`);
      console.log(`GPT Called?: ${retrieval.fallbackTriggered ? 'NO' : 'YES'}`);
      console.log(`======================================\n`);

      StructuredLogger.info(`[KnowledgeTools] Tool ${name} executed`, {
        tenantId,
        query,
        retrievedChunks: retrieval.chunks.length,
        latencyMs
      });

      if (retrieval.fallbackTriggered) {
        // Construct fallback refusal instructions
        const dbTopicLinks = await prisma.agentTopicLink.findMany({
          where: { tenantId, isActive: true },
          orderBy: { displayOrder: 'asc' },
          take: 5
        });
        let linksText = '';
        if (dbTopicLinks.length > 0) {
          linksText = dbTopicLinks.map((t: any) => t.title).join(', ');
        } else {
          const crawledPages = await prisma.crawledPage.findMany({
            where: { tenantId, enabled: true },
            take: 5
          });
          linksText = crawledPages.map((p: any) => p.title || p.url.replace(/^https?:\/\//, '')).join(', ');
        }

        const isUrdu = /[\u0600-\u06FF]/.test(query);
        const defaultUrdu = 'معذرت، میں صرف ہماری کمپنی کی خدمات اور ویب سائٹ کی معلومات کا جواب دے سکتا ہوں۔';
        const defaultEnglish = 'I can only answer questions related to our services and official knowledge base. Here are some key pages you can explore:';

        const fallbackIntro = isUrdu
          ? (agent?.RetrievalConfig?.fallbackMessageUrdu || defaultUrdu)
          : (agent?.RetrievalConfig?.fallbackMessage || defaultEnglish);

        const speechText = linksText 
          ? `${fallbackIntro} ${isUrdu ? 'جس میں شامل ہیں' : 'including'}: ${linksText}.`
          : fallbackIntro;

        return {
          resultText: `[CRITICAL OUT-OF-SCOPE REFUSAL] This query is completely out of scope of our knowledge base. You MUST refuse to answer general knowledge, coding, math, other companies, or random queries. You MUST respond exactly with this refusal text and do not add any general knowledge: "${speechText}"`,
          sources: []
        };
      }

      return {
        resultText: retrieval.contextText || `No relevant knowledge base or policy entries found matching "${query}".`,
        sources: retrieval.sources
      };
    }

    return { resultText: `Unknown tool: ${name}`, sources: [] };
  }
}
