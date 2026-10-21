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
    maxContextTokens: number = 1000,
    kbId?: string | null
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
        const isKbScoped = Boolean(kbId);

        if (isKbScoped) {
          console.log(`[RetrievalService] Scoping vector search to kbId=${kbId} for tenant=${tenantId}`);
        } else {
          console.log(`[RetrievalService] Global vector search for tenant=${tenantId}`);
        }

        // ── Phase 2: pgvector cosine search ──────────────────────────────────
        const tVec0 = Date.now();
        const rawQuery = isKbScoped
          ? `
            SELECT 
              kc.id, 
              kc.content, 
              1 - (kc.embedding::vector <=> $1::vector) as similarity,
              d.source as "sourceUrl",
              kb.name as "sourceTitle"
            FROM "KnowledgeChunk" kc
            JOIN "KnowledgeBase" kb ON kc."kbId" = kb.id
            LEFT JOIN "Document" d ON kc."documentId" = d.id
            WHERE kb."tenantId" = $2 AND kc."kbId" = $3 AND kc.embedding IS NOT NULL
            ORDER BY kc.embedding::vector <=> $1::vector ASC
            LIMIT $4;
          `
          : `
            SELECT 
              kc.id, 
              kc.content, 
              1 - (kc.embedding::vector <=> $1::vector) as similarity,
              d.source as "sourceUrl",
              kb.name as "sourceTitle"
            FROM "KnowledgeChunk" kc
            JOIN "KnowledgeBase" kb ON kc."kbId" = kb.id
            LEFT JOIN "Document" d ON kc."documentId" = d.id
            WHERE kb."tenantId" = $2 AND kc.embedding IS NOT NULL
            ORDER BY kc.embedding::vector <=> $1::vector ASC
            LIMIT $3;
          `;

        const queryParams = isKbScoped
          ? [embeddingSql, tenantId, kbId, topK]
          : [embeddingSql, tenantId, topK];

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
              if (isKbScoped) {
                const countStats: any[] = await tx.$queryRawUnsafe(`
                  SELECT 
                    (SELECT count(*)::int FROM "KnowledgeChunk" WHERE embedding IS NOT NULL) as global_count,
                    (SELECT count(*)::int FROM "KnowledgeChunk" kc JOIN "KnowledgeBase" kb ON kc."kbId" = kb.id WHERE kb."tenantId" = $1 AND kc."kbId" = $2 AND kc.embedding IS NOT NULL) as tenant_count;
                `, tenantId, kbId);
                if (countStats && countStats.length > 0) {
                  console.log(`[RetrievalService] KB Chunk counts: global=${countStats[0].global_count} | kb_count=${countStats[0].tenant_count}`);
                }
              } else {
                const countStats: any[] = await tx.$queryRawUnsafe(`
                  SELECT 
                    (SELECT count(*)::int FROM "KnowledgeChunk" WHERE embedding IS NOT NULL) as global_count,
                    (SELECT count(*)::int FROM "KnowledgeChunk" kc JOIN "KnowledgeBase" kb ON kc."kbId" = kb.id WHERE kb."tenantId" = $1 AND kc.embedding IS NOT NULL) as tenant_count;
                `, tenantId);
                if (countStats && countStats.length > 0) {
                  console.log(`[RetrievalService] Chunk counts: global=${countStats[0].global_count} | tenant=${countStats[0].tenant_count}`);
                }
              }
            } catch (countErr: any) {
              console.warn('[RetrievalService] Could not log chunk counts:', countErr?.message || countErr);
            }

            let results: any[] = await tx.$queryRawUnsafe(rawQuery, ...queryParams);

            // If vectorResults.length < topK, retry with exact sequential scan
            if (results.length < topK) {
              console.log(`[RetrievalService] Vector results (${results.length}) < topK (${topK}). Retrying with enable_indexscan = off...`);
              try {
                await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off;`);
                results = await tx.$queryRawUnsafe(rawQuery, ...queryParams);
                console.log(`[RetrievalService] Sequential scan fallback returned: ${results.length} rows`);
              } catch (retryErr: any) {
                console.warn('[RetrievalService] Exact scan retry failed, keeping initial results:', retryErr?.message || retryErr);
              }
            }

            // Fallback for non-scoped legacy searches: if 0 results in KnowledgeChunk, check legacy DocumentChunk
            if (!isKbScoped && results.length === 0) {
              try {
                const legacyQuery = `
                  SELECT id, content, metadata, 1 - (embedding::vector <=> $1::vector) as similarity
                  FROM "DocumentChunk"
                  WHERE "tenantId" = $2 AND embedding IS NOT NULL
                  ORDER BY embedding::vector <=> $1::vector ASC
                  LIMIT $3;
                `;
                results = await tx.$queryRawUnsafe(legacyQuery, embeddingSql, tenantId, topK);
                console.log(`[RetrievalService] Fallback to legacy DocumentChunk returned: ${results.length} rows`);
              } catch (legacyErr: any) {
                console.warn('[RetrievalService] Legacy DocumentChunk query error:', legacyErr?.message || legacyErr);
              }
            }

            return results;
          });
        } catch (rawErr: any) {
          console.error('[RetrievalService] Raw pgvector query threw an error:', {
            query: rawQuery,
            params: queryParams,
            error: rawErr?.message || rawErr
          });
          throw rawErr;
        }
        vectorSearchMs = Date.now() - tVec0;

        console.log('[RetrievalService] Raw rows returned:', vectorResults.length);
        if (vectorResults.length === 0) {
          console.warn('[RetrievalService] Vector query returned 0 rows for query:', {
            query,
            kbId: kbId || null,
            tenantId
          });
        }

        if (vectorResults && vectorResults.length > 0) {
          topSimilarity = parseFloat(vectorResults[0].similarity) || 0;
          for (const res of vectorResults) {
            const sim = parseFloat(res.similarity) || 0;
            // Content length filter: skip noise chunks with < 20 characters
            if (!res.content || res.content.trim().length < 20) {
              console.log(`[RetrievalService] Skipped noise chunk (content length < 20): ${res.content?.trim().length || 0} chars`);
              continue;
            }
            if (sim >= minSimilarity) {
              let title = res.sourceTitle || 'Knowledge Base Chunk';
              let url: string | undefined = res.sourceUrl;

              if (res.metadata) {
                const meta = res.metadata as any;
                title = meta.filename || meta.title || title;
                url = meta.url || url;
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
        kbId: kbId || null,
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
      kbId: kbId || null,
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
