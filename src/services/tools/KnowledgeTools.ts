import { RetrievalService, RetrievalResult } from '../ai/RetrievalService';
import { StructuredLogger } from '../logger/StructuredLogger';

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

      const retrieval: RetrievalResult = await RetrievalService.search(tenantId, query, 5, 0.1);
      const latencyMs = Date.now() - startTime;

      StructuredLogger.info(`[KnowledgeTools] Tool ${name} executed`, {
        tenantId,
        query,
        retrievedChunks: retrieval.chunks.length,
        latencyMs
      });

      return {
        resultText: retrieval.contextText || `No relevant knowledge base or policy entries found matching "${query}".`,
        sources: retrieval.sources
      };
    }

    return { resultText: `Unknown tool: ${name}`, sources: [] };
  }
}
