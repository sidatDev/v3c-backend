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
  private static pgvectorVersion: string | null = null;
  private static versionChecked: boolean = false;

  private static async getPgvectorVersion(): Promise<string | null> {
    if (this.versionChecked) return this.pgvectorVersion;
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(`SELECT extversion FROM pg_extension WHERE extname = 'vector';`);
      if (rows && rows.length > 0 && rows[0].extversion) {
        this.pgvectorVersion = String(rows[0].extversion);
      }
      this.versionChecked = true;
      console.log(`[RetrievalService] Detected pgvector extension version: ${this.pgvectorVersion || 'unknown'}`);
    } catch (err: any) {
      this.versionChecked = true;
      console.warn('[RetrievalService] Failed to detect pgvector extension version:', err?.message || err);
    }
    return this.pgvectorVersion;
  }

  private static isVersionAtLeast(version: string | null, targetMajor: number, targetMinor: number): boolean {
    if (!version) return false;
    const parts = version.split('.').map(p => parseInt(p, 10));
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    if (major > targetMajor) return true;
    if (major === targetMajor && minor >= targetMinor) return true;
    return false;
  }

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
        const rawQuery = `
          SELECT id, content, metadata, 1 - (embedding::vector <=> $1::vector) as similarity
          FROM "DocumentChunk"
          WHERE "tenantId" = $2 AND embedding IS NOT NULL
          ORDER BY embedding::vector <=> $1::vector ASC
          LIMIT $3;
        `;

        console.log('[RetrievalService] Embedding param preview:', embeddingSql.substring(0, 80));

        const version = await RetrievalService.getPgvectorVersion();
        const supportsIterativeScan = RetrievalService.isVersionAtLeast(version, 0, 8);

        let vectorResults: any[] = [];
        try {
          vectorResults = await prisma.$transaction(async (tx) => {
            let iterativeScanApplied = false;
            if (supportsIterativeScan) {
              try {
                await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = strict_order;`);
                iterativeScanApplied = true;
              } catch (e: any) {
                console.warn('[RetrievalService] Failed to SET LOCAL hnsw.iterative_scan = strict_order:', e?.message || e);
              }
            }

            try {
              await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = 200;`);
            } catch (e: any) {
              console.warn('[RetrievalService] Failed to SET LOCAL hnsw.ef_search = 200:', e?.message || e);
            }

            console.log(`[RetrievalService] HNSW tuning applied: iterative_scan=${iterativeScanApplied ? 'strict_order' : 'skipped'}, ef_search=200`);

            try {
              const countStats: any[] = await tx.$queryRawUnsafe(`
                SELECT 
                  (SELECT count(*)::int FROM "DocumentChunk" WHERE embedding IS NOT NULL) as global_count,
                  (SELECT count(*)::int FROM "DocumentChunk" WHERE "tenantId" = $1 AND embedding IS NOT NULL) as tenant_count;
              `, tenantId);
              if (countStats && countStats.length > 0) {
                console.log(`[RetrievalService] Row count before tenant filter: ${countStats[0].global_count} | After tenant filter: ${countStats[0].tenant_count}`);
              }
            } catch (countErr: any) {
              console.warn('[RetrievalService] Could not log chunk counts:', countErr?.message || countErr);
            }

            let results: any[] = await tx.$queryRawUnsafe(
              rawQuery,
              embeddingSql,
              tenantId,
              topK
            );

            // If vectorResults.length < topK, retry with exact sequential scan
            if (results.length < topK) {
              console.log(`[RetrievalService] Vector results (${results.length}) < topK (${topK}). Retrying with enable_indexscan = off...`);
              try {
                await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off;`);
                results = await tx.$queryRawUnsafe(
                  rawQuery,
                  embeddingSql,
                  tenantId,
                  topK
                );
                console.log(`[RetrievalService] Sequential scan fallback returned: ${results.length} rows`);
              } catch (retryErr: any) {
                console.warn('[RetrievalService] Exact scan retry failed, keeping initial results:', retryErr?.message || retryErr);
              }
            }

            return results;
          });
        } catch (rawErr: any) {
          console.error('[RetrievalService] Raw pgvector query threw an error:', {
            query: rawQuery,
            params: [embeddingSql.substring(0, 80), tenantId, topK],
            error: rawErr?.message || rawErr
          });
          throw rawErr;
        }
        vectorSearchMs = Date.now() - tVec0;

        console.log('[RetrievalService] Raw rows returned:', vectorResults.length);
        if (vectorResults.length === 0) {
          console.error('[RetrievalService] Vector query returned 0 rows:', {
            query: rawQuery,
            params: [embeddingSql.substring(0, 80), tenantId, topK]
          });
        }

        if (vectorResults && vectorResults.length > 0) {
          topSimilarity = parseFloat(vectorResults[0].similarity) || 0;
          for (const res of vectorResults) {
            const sim = parseFloat(res.similarity) || 0;
            // Content length filter: skip noise chunks with < 100 characters
            if (!res.content || res.content.trim().length < 100) {
              console.log(`[RetrievalService] Skipped noise chunk (content length < 100): ${res.content?.trim().length || 0} chars`);
              continue;
            }
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

    const fallbackTriggered = chunks.length === 0 || topSimilarity < minSimilarity;

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
