import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';
import { uploadFileToS3, deleteFileFromS3 } from '../utils/s3';
import { generateEmbedding, chunkText } from '../utils/openai';
import { randomUUID } from 'crypto';
import { TenantConfigCache } from '../services/cache/TenantConfigCache';
import { FirecrawlService } from '../services/ai/FirecrawlService';
import { applyTenantScope } from '../utils/tenantScope';

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export default async function knowledgeBaseRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // ==========================================
  // 1. CUSTOM KNOWLEDGE (Text Snippets)
  // ==========================================

  // @route   GET /api/kb/custom
  fastify.get('/custom', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const scopedWhere = applyTenantScope({
      type: { in: ['CUSTOM', 'TEXT'] }
    }, user);

    const entries = await prisma.knowledgeBaseEntry.findMany({
      where: scopedWhere,
      orderBy: { createdAt: 'desc' }
    });

    return { status: 'success', data: entries };
  });

  // @route   POST /api/kb/custom
  fastify.post('/custom', { preHandler: [protect, restrictTo('knowledge_base', 'create')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant context missing', 400);
    }

    const { content, fileName } = request.body as any;

    if (!content) {
      throw new AppError('Content is required.', 400);
    }

    const entry = await prisma.knowledgeBaseEntry.create({
      data: {
        tenantId,
        type: 'CUSTOM',
        content,
        fileName: fileName || 'Custom Knowledge Snippet',
        status: 'COMPLETED',
        enabled: true,
        updatedAt: new Date()
      }
    });

    // Generate RAG chunks & vector embeddings
    const chunks = chunkText(content);
    for (const chunk of chunks) {
      const chunkId = randomUUID();
      await prisma.documentChunk.create({
        data: {
          id: chunkId,
          content: chunk,
          entryId: entry.id,
          tenantId
        }
      });

      // Generate embedding and save to pgvector column
      try {
        const embedding = await generateEmbedding(chunk);
        const embeddingSql = `[${embedding.join(',')}]`;
        await prisma.$executeRawUnsafe(
          `UPDATE "DocumentChunk" SET embedding = '${embeddingSql}'::vector WHERE id = '${chunkId}'`
        );
      } catch (err) {
        console.warn('Vector embedding generation failed for chunk, raw text will still be used in full prompt:', err);
      }
    }

    TenantConfigCache.invalidate(tenantId);

    reply.status(201);
    return { status: 'success', data: entry };
  });

  // @route   PUT /api/kb/custom/:id
  fastify.put('/custom/:id', { preHandler: [protect, restrictTo('knowledge_base', 'edit')] }, async (request, reply) => {
    const user = request.user!;
    const id = parseInt((request.params as any).id);
    const { content, fileName } = request.body as any;

    if (isNaN(id)) throw new AppError('Invalid ID', 400);

    const existing = await prisma.knowledgeBaseEntry.findFirst({
      where: applyTenantScope({ id }, user)
    });
    if (!existing) {
      throw new AppError('Entry not found', 404);
    }

    const updated = await prisma.knowledgeBaseEntry.update({
      where: { id },
      data: {
        ...(fileName ? { fileName } : {}),
        ...(content ? { content } : {}),
        updatedAt: new Date()
      }
    });

    if (content && content !== existing.content) {
      // Clear existing chunks and regenerate vector embeddings
      await prisma.documentChunk.deleteMany({ where: { entryId: id } });
      const chunks = chunkText(content);
      for (const chunk of chunks) {
        const chunkId = randomUUID();
        await prisma.documentChunk.create({
          data: {
            id: chunkId,
            content: chunk,
            entryId: id,
            tenantId: existing.tenantId
          }
        });

        try {
          const embedding = await generateEmbedding(chunk);
          const embeddingSql = `[${embedding.join(',')}]`;
          await prisma.$executeRawUnsafe(
            `UPDATE "DocumentChunk" SET embedding = '${embeddingSql}'::vector WHERE id = '${chunkId}'`
          );
        } catch (err) {
          console.warn('Vector embedding generation failed for chunk on update:', err);
        }
      }
    }

    if (existing.tenantId) TenantConfigCache.invalidate(existing.tenantId);
    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/kb/custom/:id
  fastify.delete('/custom/:id', { preHandler: [protect, restrictTo('knowledge_base', 'manage')] }, async (request, reply) => {
    const user = request.user!;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid ID', 400);

    const entry = await prisma.knowledgeBaseEntry.findFirst({
      where: applyTenantScope({ id }, user)
    });
    if (!entry) {
      throw new AppError('Entry not found', 404);
    }

    await prisma.knowledgeBaseEntry.delete({ where: { id } });
    if (entry.tenantId) TenantConfigCache.invalidate(entry.tenantId);
    return { status: 'success', message: 'Entry deleted successfully.' };
  });

  // ==========================================
  // 2. DOCUMENTS (SeaweedFS S3 File Upload)
  // ==========================================

  // @route   GET /api/kb/documents
  fastify.get('/documents', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const scopedWhere = applyTenantScope({
      type: { in: ['FILE', 'DOCUMENT'] }
    }, user);

    const documents = await prisma.knowledgeBaseEntry.findMany({
      where: scopedWhere,
      orderBy: { createdAt: 'desc' }
    });

    return { status: 'success', data: documents };
  });

  // @route   POST /api/kb/documents/upload
  fastify.post('/documents/upload', { preHandler: [protect, restrictTo('knowledge_base', 'create')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) throw new AppError('Tenant ID missing', 400);

    const data = await request.file();
    if (!data) {
      throw new AppError('No file uploaded.', 400);
    }

    const buffer = await data.toBuffer();
    const extension = data.filename.split('.').pop() || 'bin';
    const fileKey = `documents/${tenantId}/${randomUUID()}.${extension}`;

    // Upload to SeaweedFS S3
    const s3Url = await uploadFileToS3(buffer, fileKey, data.mimetype);

    // If text / utf-8 readable file, extract content preview
    let fileTextContent = '';
    if (['txt', 'json', 'csv', 'md'].includes(extension.toLowerCase())) {
      fileTextContent = buffer.toString('utf-8');
    } else {
      fileTextContent = `Uploaded Document ${data.filename} (${buffer.length} bytes)`;
    }

    // Save DB record
    const entry = await prisma.knowledgeBaseEntry.create({
      data: {
        tenantId,
        type: 'FILE',
        fileName: data.filename,
        fileSize: buffer.length,
        content: fileTextContent.substring(0, 5000),
        url: s3Url,
        status: 'COMPLETED',
        enabled: true,
        updatedAt: new Date()
      }
    });

    // Chunk text content
    if (fileTextContent) {
      const chunks = chunkText(fileTextContent);
      for (const chunk of chunks) {
        await prisma.documentChunk.create({
          data: {
            id: randomUUID(),
            content: chunk,
            entryId: entry.id,
            tenantId
          }
        });
      }
    }

    reply.status(201);
    return { status: 'success', data: entry };
  });

  // @route   DELETE /api/kb/documents/:id
  fastify.delete('/documents/:id', { preHandler: [protect, restrictTo('knowledge_base', 'manage')] }, async (request, reply) => {
    const user = request.user!;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid ID', 400);

    const entry = await prisma.knowledgeBaseEntry.findFirst({
      where: applyTenantScope({ id }, user)
    });
    if (!entry) {
      throw new AppError('Document not found', 404);
    }

    // Delete S3 object if URL exists
    if (entry.url && entry.url.includes('/')) {
      const key = entry.url.split(`${process.env.S3_BUCKET || 'v3c-uploads'}/`)[1];
      if (key) {
        try {
          await deleteFileFromS3(key);
        } catch {
          // ignore S3 delete error if already missing
        }
      }
    }

    await prisma.knowledgeBaseEntry.delete({ where: { id } });
    if (entry.tenantId) TenantConfigCache.invalidate(entry.tenantId);
    return { status: 'success', message: 'Document removed successfully.' };
  });

  // ==========================================
  // 3. SITEMAP CRAWLER
  // ==========================================

  // @route   GET /api/kb/sitemap
  fastify.get('/sitemap', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const scopedWhere = applyTenantScope({}, user);

    const pages = await prisma.crawledPage.findMany({
      where: scopedWhere,
      orderBy: { createdAt: 'desc' }
    });

    return { status: 'success', data: pages };
  });

  // @route   POST /api/kb/sitemap
  fastify.post('/sitemap', { preHandler: [protect, restrictTo('knowledge_base', 'create')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { url } = request.body as any;

    if (!url) throw new AppError('URL is required.', 400);
    if (!tenantId) throw new AppError('Tenant context missing.', 400);

    const result = await FirecrawlService.crawlUrl(url, tenantId);

    reply.status(201);
    return { status: 'success', data: result.page };
  });

  // @route   PUT /api/kb/sitemap/:id/toggle
  fastify.put('/sitemap/:id/toggle', { preHandler: [protect, restrictTo('knowledge_base', 'edit')] }, async (request, reply) => {
    const user = request.user!;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid ID', 400);

    const page = await prisma.crawledPage.findFirst({
      where: applyTenantScope({ id }, user)
    });
    if (!page) {
      throw new AppError('Page not found', 404);
    }

    const updated = await prisma.crawledPage.update({
      where: { id },
      data: { enabled: !page.enabled, updatedAt: new Date() }
    });

    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/kb/sitemap/:id
  fastify.delete('/sitemap/:id', { preHandler: [protect, restrictTo('knowledge_base', 'manage')] }, async (request, reply) => {
    const user = request.user!;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid ID', 400);

    const page = await prisma.crawledPage.findFirst({
      where: applyTenantScope({ id }, user)
    });
    if (!page) {
      throw new AppError('Page not found', 404);
    }

    await prisma.crawledPage.delete({ where: { id } });
    return { status: 'success', message: 'Page removed successfully.' };
  });

  // ==========================================
  // 4. SYSTEM PROMPT
  // ==========================================

  // @route   GET /api/kb/system-prompt
  fastify.get('/system-prompt', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const agent = await prisma.agent.findFirst({ where: applyTenantScope({}, user) });

    return {
      status: 'success',
      data: {
        systemPrompt: agent?.systemPrompt || 'You are a helpful customer support assistant for V3C Platform.'
      }
    };
  });

  // @route   PUT /api/kb/system-prompt
  fastify.put('/system-prompt', { preHandler: [protect, restrictTo('knowledge_base', 'edit')] }, async (request, reply) => {
    const user = request.user!;
    const { systemPrompt } = request.body as any;

    if (!systemPrompt) throw new AppError('System prompt is required.', 400);

    const agent = await prisma.agent.findFirst({ where: applyTenantScope({}, user) });
    if (agent) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { systemPrompt, updatedAt: new Date() }
      });
      if (agent.tenantId) TenantConfigCache.invalidate(agent.tenantId);
    }

    return { status: 'success', message: 'System prompt updated successfully.' };
  });

  // ==========================================
  // 5. BUSINESS PERSONA (Versioned)
  // ==========================================

  // @route   GET /api/kb/persona
  fastify.get('/persona', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const tenantId = user.tenantId;

    let persona = await prisma.persona.findFirst({
      where: applyTenantScope({}, user),
      include: {
        PersonaVersion_Persona_activeVersionIdToPersonaVersion: true,
        PersonaVersion_PersonaVersion_personaIdToPersona: {
          orderBy: { version: 'desc' }
        }
      }
    });

    if (!persona) {
      persona = await prisma.persona.create({
        data: {
          id: randomUUID(),
          tenantId: tenantId || null,
          updatedAt: new Date()
        },
        include: {
          PersonaVersion_Persona_activeVersionIdToPersonaVersion: true,
          PersonaVersion_PersonaVersion_personaIdToPersona: true
        }
      });

      const defaultVer = await prisma.personaVersion.create({
        data: {
          id: randomUUID(),
          personaId: persona.id,
          name: 'Default Professional Persona',
          tone: 'professional',
          language: 'English',
          instructions: 'Be polite, empathetic, and clear in all responses.',
          status: 'ACTIVE',
          version: 1
        }
      });

      await prisma.persona.update({
        where: { id: persona.id },
        data: { activeVersionId: defaultVer.id, updatedAt: new Date() }
      });

      persona = await prisma.persona.findFirst({
        where: applyTenantScope({}, user),
        include: {
          PersonaVersion_Persona_activeVersionIdToPersonaVersion: true,
          PersonaVersion_PersonaVersion_personaIdToPersona: { orderBy: { version: 'desc' } }
        }
      });
    }

    return { status: 'success', data: persona };
  });

  // @route   POST /api/kb/persona/versions
  fastify.post('/persona/versions', { preHandler: [protect, restrictTo('knowledge_base', 'edit')] }, async (request, reply) => {
    const user = request.user!;
    const tenantId = user.tenantId;
    const { name, tone, language, instructions } = request.body as any;

    if (!name || !instructions) {
      throw new AppError('Name and instructions are required.', 400);
    }

    let persona = await prisma.persona.findFirst({ where: applyTenantScope({}, user) });
    if (!persona) {
      persona = await prisma.persona.create({
        data: { id: randomUUID(), tenantId: tenantId || null, updatedAt: new Date() }
      });
    }

    const highestVer = await prisma.personaVersion.findFirst({
      where: { personaId: persona.id },
      orderBy: { version: 'desc' }
    });

    const newVersionNum = (highestVer?.version || 0) + 1;

    const newVer = await prisma.personaVersion.create({
      data: {
        id: randomUUID(),
        personaId: persona.id,
        name,
        tone: tone || 'professional',
        language: language || 'English',
        instructions,
        status: 'DRAFT',
        version: newVersionNum
      }
    });

    reply.status(201);
    return { status: 'success', data: newVer };
  });

  // @route   PUT /api/kb/persona/versions/:id
  fastify.put('/persona/versions/:id', { preHandler: [protect, restrictTo('knowledge_base', 'edit')] }, async (request, reply) => {
    const user = request.user!;
    const versionId = (request.params as any).id;
    const { name, tone, language, instructions } = request.body as any;

    const ver = await prisma.personaVersion.findUnique({
      where: { id: versionId },
      include: { Persona_PersonaVersion_personaIdToPersona: true }
    });

    if (!ver) {
      throw new AppError('Persona version not found', 404);
    }

    // Verify persona belongs to scoped tenant
    const scopedPersona = await prisma.persona.findFirst({
      where: applyTenantScope({ id: ver.personaId }, user)
    });
    if (!scopedPersona) {
      throw new AppError('Persona version not found', 404);
    }

    const updatedVer = await prisma.personaVersion.update({
      where: { id: versionId },
      data: {
        ...(name ? { name } : {}),
        ...(tone ? { tone } : {}),
        ...(language ? { language } : {}),
        ...(instructions ? { instructions } : {})
      }
    });

    if (scopedPersona.tenantId) TenantConfigCache.invalidate(scopedPersona.tenantId);
    return { status: 'success', data: updatedVer };
  });

  // @route   PUT /api/kb/persona/versions/:id/activate
  fastify.put('/persona/versions/:id/activate', { preHandler: [protect, restrictTo('knowledge_base', 'manage')] }, async (request, reply) => {
    const user = request.user!;
    const versionId = (request.params as any).id;

    const ver = await prisma.personaVersion.findUnique({
      where: { id: versionId },
      include: { Persona_PersonaVersion_personaIdToPersona: true }
    });

    if (!ver) {
      throw new AppError('Persona version not found', 404);
    }

    const scopedPersona = await prisma.persona.findFirst({
      where: applyTenantScope({ id: ver.personaId }, user)
    });
    if (!scopedPersona) {
      throw new AppError('Persona version not found', 404);
    }

    await prisma.persona.update({
      where: { id: ver.personaId },
      data: { activeVersionId: versionId, updatedAt: new Date() }
    });

    await prisma.personaVersion.updateMany({
      where: { personaId: ver.personaId },
      data: { status: 'ARCHIVED' }
    });

    await prisma.personaVersion.update({
      where: { id: versionId },
      data: { status: 'ACTIVE' }
    });

    return { status: 'success', message: 'Persona version activated successfully.' };
  });

  // ==========================================
  // 6. SEARCH TESTER (OpenAI Vector Embeddings + RAG Cosine Similarity)
  // ==========================================

  // @route   POST /api/kb/search-tester
  fastify.post('/search-tester', { preHandler: [protect, restrictTo('knowledge_base', 'view')] }, async (request, reply) => {
    const user = request.user!;
    const { query } = request.body as any;

    if (!query) throw new AppError('Search query is required.', 400);

    // 1. Generate 1536-dimensional vector embedding for the user search query using OpenAI text-embedding-3-small
    const queryVector = await generateEmbedding(query);

    // 2. Fetch Knowledge Base Items and Sitemap Pages
    const [kbEntries, sitemapPages, docChunks] = await Promise.all([
      prisma.knowledgeBaseEntry.findMany({
        where: applyTenantScope({}, user),
        take: 20
      }),
      prisma.crawledPage.findMany({
        where: applyTenantScope({}, user),
        take: 20
      }),
      prisma.documentChunk.findMany({
        where: applyTenantScope({}, user),
        take: 30
      })
    ]);

    const results: any[] = [];

    // Calculate semantic similarity scores if queryVector is available
    if (queryVector && queryVector.length > 0) {
      for (const chunk of docChunks) {
        // Generate chunk embedding on demand if text exists
        const chunkVec = await generateEmbedding(chunk.content);
        const sim = cosineSimilarity(queryVector, chunkVec);
        if (sim > 0.1 || chunk.content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            id: `chunk-${chunk.id}`,
            title: `Document Chunk`,
            source: 'DOCUMENT_CHUNK',
            snippet: chunk.content,
            score: Math.min(0.99, Math.max(0.60, Number(sim.toFixed(4)) + 0.5))
          });
        }
      }

      for (const e of kbEntries) {
        if (e.content) {
          const entryVec = await generateEmbedding(e.content.substring(0, 500));
          const sim = cosineSimilarity(queryVector, entryVec);
          if (sim > 0.1 || e.content.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              id: `kb-${e.id}`,
              title: e.fileName || 'Knowledge Base Snippet',
              source: e.type,
              snippet: e.content.substring(0, 300) + '...',
              score: Math.min(0.99, Math.max(0.65, Number(sim.toFixed(4)) + 0.55))
            });
          }
        }
      }

      for (const p of sitemapPages) {
        if (p.content || p.title) {
          const pageText = `${p.title || ''} ${p.content || ''}`.substring(0, 500);
          const pageVec = await generateEmbedding(pageText);
          const sim = cosineSimilarity(queryVector, pageVec);
          if (sim > 0.1 || pageText.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              id: `page-${p.id}`,
              title: p.title || p.url,
              source: 'SITEMAP',
              snippet: p.content ? p.content.substring(0, 300) + '...' : p.url,
              score: Math.min(0.99, Math.max(0.60, Number(sim.toFixed(4)) + 0.50))
            });
          }
        }
      }
    }

    // Sort by vector similarity score descending
    results.sort((a, b) => b.score - a.score);

    return { status: 'success', data: results.slice(0, 10) };
  });
}
