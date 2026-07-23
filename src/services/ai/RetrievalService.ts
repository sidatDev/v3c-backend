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
  topSimilarity: number;
  fallbackTriggered: boolean;
  /**
   * Timing breakdown for latency instrumentation.
   * All values are milliseconds since the search() call began.
   */
  timings: {
    embeddingMs: number;
    vectorSearchMs: number;
    totalMs: number;
  };
}

export class RetrievalService {
  /**
   * Perform vector search and fallback retrieval for a tenant & user query.
   * Instruments each phase with precise ms timings.
   */
  static async search(
    tenantId: string,
    query: string,
    topK: number = 5,
    minSimilarity: number = 0.3,
    maxContextTokens: number = 1000
  ): Promise<RetrievalResult> {
    const t0 = Date.now();
    const chunks: RetrievedChunk[] = [];
    const sourcesMap: Map<string, { title: string; url?: string }> = new Map();
    let topSimilarity = 0;
    let embeddingMs = 0;
    let vectorSearchMs = 0;

    try {
      // ── Phase 1: Generate embedding ─────────────────────────────────────────
      const tEmbed0 = Date.now();
      const queryEmbedding = await generateEmbedding(query);
      embeddingMs = Date.now() - tEmbed0;

      if (queryEmbedding && queryEmbedding.length > 0) {
        const embeddingSql = `[${queryEmbedding.join(',')}]`;

        // ── Phase 2: pgvector cosine search ──────────────────────────────────
        const tVec0 = Date.now();
        const vectorResults: any[] = await prisma.$queryRawUnsafe(`
          SELECT id, content, metadata, 1 - (embedding <=> '${embeddingSql}'::vector) as similarity
          FROM "DocumentChunk"
          WHERE "tenantId" = '${tenantId}' AND embedding IS NOT NULL
          ORDER BY embedding <=> '${embeddingSql}'::vector ASC
          LIMIT ${topK};
        `);
        vectorSearchMs = Date.now() - tVec0;

        if (vectorResults && vectorResults.length > 0) {
          topSimilarity = parseFloat(vectorResults[0].similarity) || 0;
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
      StructuredLogger.warn('[RetrievalService] Vector search failed', {
        tenantId,
        error: err?.message || err
      });
    }

    const fallbackTriggered = chunks.length === 0;

    // Fallback: If vector search returned 0 results matching similarity threshold
    if (fallbackTriggered) {
      try {
        const kbEntries = await prisma.knowledgeBaseEntry.findMany({
          where: { tenantId, enabled: true },
          orderBy: { createdAt: 'desc' },
          take: 3
        });

        for (const entry of kbEntries) {
          if (entry.content && entry.content.trim()) {
            const title = entry.fileName || 'Knowledge Base Entry';
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

    const maxChars = maxContextTokens * 4;
    const truncatedContext = contextText.length > maxChars ? contextText.substring(0, maxChars) + '\n[... truncated ...]' : contextText;

    const totalMs = Date.now() - t0;
    const timings = { embeddingMs, vectorSearchMs, totalMs };

    StructuredLogger.info('[RetrievalService] Search completed', {
      tenantId,
      retrievedChunks: chunks.length,
      topSimilarity,
      avgSimilarity,
      fallbackTriggered,
      timings
    });

    // Latency budget warning
    if (totalMs > 400) {
      console.warn(`[RetrievalService] ⚠ LATENCY BUDGET EXCEEDED: total=${totalMs}ms (embedding=${embeddingMs}ms, pgvector=${vectorSearchMs}ms). Target: <400ms`);
    }

    return {
      chunks,
      contextText: truncatedContext,
      sources,
      avgSimilarity,
      topSimilarity,
      fallbackTriggered,
      timings
    };
  }
}
