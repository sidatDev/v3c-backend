import prisma from '../../lib/prisma';
import { generateEmbedding } from '../../utils/openai';
import { StructuredLogger } from '../logger/StructuredLogger';

export interface RetrievedChunk {
  id?: string;
  content: string;
  similarity: number;
  sourceTitle?: string;
  sourceUrl?: string;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  contextText: string;
  sources: { title: string; url?: string }[];
  avgSimilarity: number;
}

export class RetrievalService {
  /**
   * Perform vector search and fallback retrieval for a tenant & user query
   */
  static async search(tenantId: string, query: string, topK: number = 5, minSimilarity: number = 0.1): Promise<RetrievalResult> {
    const startTime = Date.now();
    const chunks: RetrievedChunk[] = [];
    const sourcesMap: Map<string, { title: string; url?: string }> = new Map();

    try {
      const queryEmbedding = await generateEmbedding(query);
      
      if (queryEmbedding && queryEmbedding.length > 0) {
        const embeddingSql = `[${queryEmbedding.join(',')}]`;

        const vectorResults: any[] = await prisma.$queryRawUnsafe(`
          SELECT id, content, metadata, 1 - (embedding <=> '${embeddingSql}'::vector) as similarity
          FROM "DocumentChunk"
          WHERE "tenantId" = '${tenantId}' AND embedding IS NOT NULL
          ORDER BY embedding <=> '${embeddingSql}'::vector ASC
          LIMIT ${topK};
        `);

        if (vectorResults && vectorResults.length > 0) {
          for (const res of vectorResults) {
            const sim = parseFloat(res.similarity) || 0;
            if (sim >= minSimilarity) {
              let title = 'Knowledge Base Chunk';
              let url: string | undefined = undefined;

              if (res.metadata) {
                const meta = res.metadata as any;
                title = meta.filename || meta.title || title;
                url = meta.url;
              }

              chunks.push({
                id: res.id,
                content: res.content,
                similarity: sim,
                sourceTitle: title,
                sourceUrl: url
              });

              sourcesMap.set(title + (url || ''), { title, url });
            }
          }
        }
      }
    } catch (err: any) {
      StructuredLogger.warn('[RetrievalService] Vector search failed, attempting fallback', {
        tenantId,
        error: err?.message || err
      });
    }

    // Fallback: If vector search returned 0 results, load raw KnowledgeBaseEntry snippets for tenant
    if (chunks.length === 0) {
      try {
        const kbEntries = await prisma.knowledgeBaseEntry.findMany({
          where: { tenantId, enabled: true },
          orderBy: { createdAt: 'desc' },
          take: 5
        });

        for (const entry of kbEntries) {
          if (entry.content && entry.content.trim()) {
            const title = entry.fileName || 'Knowledge Base Entry';
            chunks.push({
              content: entry.content,
              similarity: 0.5, // default baseline score for full match
              sourceTitle: title
            });
            sourcesMap.set(title, { title });
          }
        }
      } catch (err: any) {
        StructuredLogger.error('[RetrievalService] Fallback KB fetch failed', {
          tenantId,
          error: err?.message || err
        });
      }
    }

    const contextText = chunks.map(c => `[SOURCE: ${c.sourceTitle || 'Knowledge Base'}]\n${c.content}`).join('\n\n---\n\n');
    const sources = Array.from(sourcesMap.values());
    const totalSim = chunks.reduce((acc, c) => acc + c.similarity, 0);
    const avgSimilarity = chunks.length > 0 ? totalSim / chunks.length : 0;

    const latencyMs = Date.now() - startTime;
    StructuredLogger.info('[RetrievalService] Search completed', {
      tenantId,
      retrievedChunks: chunks.length,
      avgSimilarity,
      latencyMs
    });

    return {
      chunks,
      contextText: contextText.length > 6000 ? contextText.substring(0, 6000) + '\n[... truncated ...]' : contextText,
      sources,
      avgSimilarity
    };
  }
}
