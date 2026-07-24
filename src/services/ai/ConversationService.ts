import prisma from '../../lib/prisma';
import { openai } from '../../utils/openai';
import { StructuredLogger } from '../logger/StructuredLogger';

export interface MessageRecord {
  sender: 'visitor' | 'ai' | 'user' | 'assistant';
  message: string;
  createdAt?: Date;
}

// In-memory cache for session rolling summaries to avoid re-summarizing on every turn
const sessionSummaryCache = new Map<number, { summary: string; messageCount: number }>();

export class ConversationService {
  /**
   * Load recent messages and summary for a session
   */
  static async getSessionContext(sessionId: number, tenantId: string, limit: number = 8): Promise<{
    recentMessages: MessageRecord[];
    summary: string | undefined;
    dbSession: any;
    leadId: number | null;
  }> {
    const dbSession = await prisma.visitorSession.findFirst({
      where: { id: sessionId, tenantId }
    });

    if (!dbSession) {
      return { recentMessages: [], summary: undefined, dbSession: null, leadId: null };
    }

    // Find or create lead for tracking
    let lead = await prisma.lead.findFirst({
      where: { visitorSessionId: dbSession.id }
    });

    if (!lead && dbSession.aiAgentId) {
      try {
        lead = await prisma.lead.create({
          data: {
            name: 'Visitor Lead',
            tenantId,
            aiAgentId: dbSession.aiAgentId,
            visitorId: dbSession.visitorId,
            visitorSessionId: dbSession.id,
            status: 'new',
            updatedAt: new Date()
          }
        });
      } catch (err: any) {
        StructuredLogger.warn('[ConversationService] Lead auto-creation warning', { error: err?.message });
      }
    }

    const conversations = await prisma.conversation.findMany({
      where: { visitorSessionId: dbSession.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit + 6 // fetch extra to detect if summarization needed
    });

    // Reverse to get chronological order
    conversations.reverse();

    let recentMessages: MessageRecord[] = [];
    let summary: string | undefined = undefined;

    if (conversations.length > limit) {
      const olderMessages = conversations.slice(0, conversations.length - limit);
      recentMessages = conversations.slice(conversations.length - limit).map(c => ({
        sender: c.sender as any,
        message: c.message,
        createdAt: c.createdAt
      }));

      // Token optimization: check cache first; re-summarize only if >= 6 new messages accumulated
      const cached = sessionSummaryCache.get(sessionId);
      if (cached && (conversations.length - cached.messageCount < 6)) {
        summary = cached.summary;
      } else {
        summary = await this.summarizeMessages(olderMessages);
        if (summary) {
          sessionSummaryCache.set(sessionId, { summary, messageCount: conversations.length });
        }
      }
    } else {
      recentMessages = conversations.map(c => ({
        sender: c.sender as any,
        message: c.message,
        createdAt: c.createdAt
      }));
    }

    return {
      recentMessages,
      summary,
      dbSession,
      leadId: lead ? lead.id : null
    };
  }

  /**
   * Save a message (visitor or AI) to DB
   */
  static async saveMessage(params: {
    tenantId: string;
    agentId: string;
    sessionId?: number | null;
    visitorId?: number | null;
    leadId?: number | null;
    sender: 'visitor' | 'ai';
    message: string;
  }): Promise<void> {
    const { tenantId, agentId, sessionId, visitorId, leadId, sender, message } = params;

    if (!sessionId || !leadId) return;

    try {
      await prisma.conversation.create({
        data: {
          tenantId,
          aiAgentId: agentId,
          visitorId: visitorId || null,
          visitorSessionId: sessionId,
          sender,
          message: message.trim(),
          leadId
        }
      });
    } catch (err: any) {
      StructuredLogger.error('[ConversationService] Failed to save conversation message', {
        tenantId,
        sessionId,
        error: err?.message || err
      });
    }
  }

  /**
   * Generate a concise summary of older conversation turns
   */
  private static async summarizeMessages(messages: any[]): Promise<string | undefined> {
    try {
      const formatted = messages.map(m => `${m.sender.toUpperCase()}: ${m.message}`).join('\n');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Summarize the following customer service conversation history in 2-3 concise sentences focusing on key facts and user intent.'
          },
          { role: 'user', content: formatted }
        ],
        max_tokens: 200,
        temperature: 0.3
      });

      return response.choices[0]?.message?.content || undefined;
    } catch (err: any) {
      StructuredLogger.warn('[ConversationService] Rolling summary generation failed', { error: err?.message });
      return undefined;
    }
  }
}
