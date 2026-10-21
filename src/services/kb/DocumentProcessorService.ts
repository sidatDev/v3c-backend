import { randomUUID } from 'crypto';
import fs from 'node:fs/promises';
import pdfParse from 'pdf-parse';
import prisma from '../../lib/prisma';
import { generateEmbedding, chunkText } from '../../utils/openai';

export class DocumentProcessorError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = 'DocumentProcessorError';
    this.statusCode = statusCode;
  }
}

/**
 * Strips script tags, style tags, HTML tags, and condenses whitespace.
 */
function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class DocumentProcessorService {
  /**
   * Process a pending document:
   * 1. Verify tenant isolation.
   * 2. Fetch & extract text (strip HTML for URLs).
   * 3. Split text into ~500-800 character chunks.
   * 4. Generate 1536-dim vector embeddings for each chunk.
   * 5. Atomically insert KnowledgeChunk records & update Document status to 'ready'.
   */
  static async processDocument(documentId: string, tenantId: string): Promise<void> {
    console.log(`[DocumentProcessorService] Starting processing for doc=${documentId}, tenant=${tenantId}`);

    // Step A: Fetch & Verify
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { kb: true },
    });

    if (!document) {
      throw new DocumentProcessorError('Document not found', 404);
    }

    if (document.kb.tenantId !== tenantId) {
      console.warn(`[DocumentProcessorService] Tenant mismatch: doc tenant=${document.kb.tenantId}, req tenant=${tenantId}`);
      throw new DocumentProcessorError('Forbidden: Document does not belong to tenant', 403);
    }

    // Gracefully handle if already processed or processing
    if (document.status === 'ready') {
      console.log(`[DocumentProcessorService] Document ${documentId} is already ready. Skipping.`);
      return;
    }

    if (document.status === 'processing') {
      console.log(`[DocumentProcessorService] Document ${documentId} is already processing. Skipping.`);
      return;
    }

    // Mark as processing
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'processing' },
    });

    try {
      // Step B: Fetch Content
      let rawText = '';

      if (document.type === 'url') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const res = await fetch(document.source, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'V3C-DocumentProcessor/1.0',
              'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            },
          });

          if (!res.ok) {
            throw new Error(`Failed to fetch URL (${res.status} ${res.statusText})`);
          }

          const html = await res.text();
          rawText = cleanHtml(html);
        } finally {
          clearTimeout(timeout);
        }
      } else if (document.type === 'text') {
        rawText = document.source.trim();
      } else if (document.type === 'txt') {
        const fileContent = await fs.readFile(document.source, 'utf-8');
        rawText = fileContent.trim();
      } else if (document.type === 'pdf') {
        try {
          const buffer = await fs.readFile(document.source);
          const data = await pdfParse(buffer);
          const text = (data?.text || '').replace(/\s+/g, ' ').trim();

          if (!text) {
            console.warn(
              `[DocumentProcessorService] No text extracted from PDF for doc ${documentId}. Marking document as failed.`
            );
            await prisma.document.update({
              where: { id: documentId },
              data: { status: 'failed' },
            });
            return;
          }

          rawText = text;
        } catch (pdfErr: any) {
          console.warn(
            `[DocumentProcessorService] Failed to parse PDF for doc ${documentId} (${pdfErr?.message || pdfErr}). Note: No text extracted from PDF. Marking document as failed.`
          );
          await prisma.document.update({
            where: { id: documentId },
            data: { status: 'failed' },
          });
          return;
        }
      } else {
        throw new Error(`Unsupported document type: ${document.type}`);
      }

      if (!rawText || rawText.trim().length === 0) {
        throw new Error('No readable text content extracted from document source');
      }

      console.log(`[DocumentProcessorService] Extracted ${rawText.length} characters from doc ${documentId}`);

      // Step C: Chunking (max ~800 chars respecting sentence boundaries)
      const textChunks = chunkText(rawText, 800);
      if (!textChunks || textChunks.length === 0) {
        throw new Error('Failed to generate chunks from document content');
      }

      console.log(`[DocumentProcessorService] Generated ${textChunks.length} chunks for doc ${documentId}`);

      // Step D: Embeddings
      const chunksWithEmbeddings: { id: string; content: string; embedding: number[] }[] = [];

      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];
        const embedding = await generateEmbedding(chunk);

        if (!embedding || embedding.length === 0) {
          console.warn(`[DocumentProcessorService] Empty embedding generated for chunk ${i} of doc ${documentId}. Retrying once...`);
          const retryEmbedding = await generateEmbedding(chunk);
          if (!retryEmbedding || retryEmbedding.length === 0) {
            throw new Error(`Embedding generation failed for chunk index ${i}`);
          }
          chunksWithEmbeddings.push({
            id: randomUUID(),
            content: chunk,
            embedding: retryEmbedding,
          });
        } else {
          chunksWithEmbeddings.push({
            id: randomUUID(),
            content: chunk,
            embedding,
          });
        }
      }

      console.log(`[DocumentProcessorService] Successfully embedded ${chunksWithEmbeddings.length} chunks`);

      // Step E & F: Transactional save into KnowledgeChunk & update status to 'ready'
      await prisma.$transaction([
        // Clear previous chunks for idempotency if re-processed
        prisma.knowledgeChunk.deleteMany({
          where: { documentId: document.id },
        }),
        // Bulk insert new chunks
        prisma.knowledgeChunk.createMany({
          data: chunksWithEmbeddings.map((c) => ({
            id: c.id,
            kbId: document.kbId,
            documentId: document.id,
            content: c.content,
            embedding: c.embedding,
          })),
        }),
        // Update document status to ready
        prisma.document.update({
          where: { id: document.id },
          data: { status: 'ready' },
        }),
      ]);

      console.log(`[DocumentProcessorService] Document ${documentId} successfully processed and marked ready.`);
    } catch (error: any) {
      console.error(`[DocumentProcessorService] Processing failed for doc ${documentId}:`, error?.message || error);

      // Finalize error state: set status to 'failed'
      try {
        await prisma.document.update({
          where: { id: documentId },
          data: { status: 'failed' },
        });
      } catch (dbErr) {
        console.error('[DocumentProcessorService] Failed to mark document status as failed in DB:', dbErr);
      }

      throw error;
    }
  }
}

// Named export as requested
export const processDocument = DocumentProcessorService.processDocument;
