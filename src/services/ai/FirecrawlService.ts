import FirecrawlApp from '@mendable/firecrawl-js';
import prisma from '../../lib/prisma';
import { generateEmbedding, chunkText } from '../../utils/openai';
import { TenantConfigCache } from '../cache/TenantConfigCache';
import { StructuredLogger } from '../logger/StructuredLogger';
import { randomUUID } from 'crypto';

export class FirecrawlService {
  /**
   * Crawl a website URL using Firecrawl API with intelligent fallback, chunking & vector embedding generation
   */
  static async crawlUrl(url: string, tenantId: string): Promise<{ success: boolean; page: any; error?: string }> {
    const startTime = Date.now();
    StructuredLogger.info('[FirecrawlService] Starting URL crawl', { url, tenantId });

    // 1. Create or find CrawledPage record in PENDING state
    let crawled = await prisma.crawledPage.upsert({
      where: { url },
      update: {
        status: 'PENDING',
        tenantId,
        error: null,
        updatedAt: new Date()
      },
      create: {
        url,
        tenantId,
        status: 'PENDING',
        enabled: true,
        updatedAt: new Date()
      }
    });

    let extractedTitle = url;
    let extractedContent = '';
    let crawlSuccess = false;
    let errorMessage: string | null = null;

    // 2. Try Firecrawl API first if API key is configured
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
    if (firecrawlApiKey && firecrawlApiKey.trim() !== '') {
      try {
        const app = new FirecrawlApp({ apiKey: firecrawlApiKey });
        const scrapeResult: any = await app.scrapeUrl(url, { formats: ['markdown', 'html'] });

        if (scrapeResult.success && (scrapeResult.markdown || scrapeResult.html)) {
          extractedTitle = scrapeResult.metadata?.title || url;
          extractedContent = scrapeResult.markdown || scrapeResult.html || '';
          crawlSuccess = true;
          StructuredLogger.info('[FirecrawlService] Firecrawl API scrape succeeded', { url, title: extractedTitle });
        } else {
          errorMessage = scrapeResult.error || 'Firecrawl scrape failed';
        }
      } catch (err: any) {
        StructuredLogger.warn('[FirecrawlService] Firecrawl SDK error, falling back to HTTP browser scraper', {
          error: err?.message || err
        });
      }
    }

    // 3. Fallback: Browser-Emulated HTTP Scraper (handles Cloudflare WAF & browser headers)
    if (!crawlSuccess) {
      try {
        const userAgents = [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];

        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': randomUserAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });

        if (response.ok) {
          const html = await response.text();
          const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          extractedTitle = titleMatch ? titleMatch[1].trim() : url;

          // Strip HTML tags, scripts, styles to produce clean text
          extractedContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (extractedContent.length > 50) {
            crawlSuccess = true;
          } else {
            errorMessage = 'Extracted content too short';
          }
        } else if (response.status === 403) {
          errorMessage = 'HTTP 403: Cloudflare WAF protection detected. To crawl Cloudflare-protected sites, please add FIRECRAWL_API_KEY to v3c-backend/.env or paste text into /knowledge-base/custom.';
        } else {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (err: any) {
        errorMessage = err?.message || 'Crawl error';
      }
    }

    // 4. Update CrawledPage DB Record
    if (crawlSuccess && extractedContent.trim()) {
      crawled = await prisma.crawledPage.update({
        where: { id: crawled.id },
        data: {
          title: extractedTitle,
          content: extractedContent.substring(0, 50000), // store up to 50k chars
          status: 'COMPLETED',
          error: null,
          lastCrawled: new Date(),
          updatedAt: new Date()
        }
      });

      // Delete old DocumentChunk records for this page before re-chunking
      await prisma.documentChunk.deleteMany({
        where: { pageId: crawled.id }
      });

      // 5. Chunk Content & Generate RAG Vector Embeddings
      const chunks = chunkText(extractedContent, 800);
      let embeddedCount = 0;

      for (const chunk of chunks) {
        const chunkId = randomUUID();
        const metadata = {
          url: crawled.url,
          title: extractedTitle,
          filename: extractedTitle
        };

        await prisma.documentChunk.create({
          data: {
            id: chunkId,
            content: chunk,
            pageId: crawled.id,
            tenantId,
            metadata
          }
        });

        // Generate 1536-dim vector embedding via OpenAI
        try {
          const embedding = await generateEmbedding(chunk);
          if (embedding && embedding.length > 0) {
            const embeddingSql = `[${embedding.join(',')}]`;
            await prisma.$executeRawUnsafe(
              `UPDATE "DocumentChunk" SET embedding = '${embeddingSql}'::vector WHERE id = '${chunkId}'`
            );
            embeddedCount++;
          }
        } catch (err: any) {
          StructuredLogger.warn('[FirecrawlService] Chunk embedding failed', { chunkId, error: err?.message });
        }
      }

      // Invalidate tenant cache to ensure fresh RAG memory
      TenantConfigCache.invalidate(tenantId);

      const latencyMs = Date.now() - startTime;
      StructuredLogger.info('[FirecrawlService] Crawl and RAG vectorization complete', {
        url,
        tenantId,
        chunksCount: chunks.length,
        embeddedCount,
        latencyMs
      });

      return { success: true, page: crawled };
    } else {
      // Mark as FAILED
      crawled = await prisma.crawledPage.update({
        where: { id: crawled.id },
        data: {
          status: 'FAILED',
          error: errorMessage || 'Failed to extract website content',
          updatedAt: new Date()
        }
      });

      return { success: false, page: crawled, error: errorMessage || 'Failed to extract website content' };
    }
  }
}
