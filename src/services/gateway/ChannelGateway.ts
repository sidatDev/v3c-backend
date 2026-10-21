import { randomUUID } from 'crypto';

export type ChannelType =
  | 'web'
  | 'voice'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'sdk'
  | 'phone';

export type MessageLanguage = 'en' | 'ur' | 'unknown';

export interface V3CMessage {
  messageId: string;
  channel: ChannelType;
  tenantId: string;
  sessionId: string;
  language: MessageLanguage;
  content: string;
  metadata: Record<string, any>;
  receivedAt: string;
}

export interface IngestInput {
  channel: ChannelType;
  tenantId?: string | null;
  sessionId?: string | number | null;
  language?: string | null;
  content: string;
  metadata?: Record<string, any>;
}

/**
 * Ingests an incoming channel message into the V3C Channel Gateway.
 * Observation only: builds V3CMessage, logs to console, no DB writes, no queue publish, no await.
 * Never throws: wraps in try/catch, logs error, and returns null on failure.
 */
export function ingest(input: IngestInput): V3CMessage | null {
  try {
    let language: MessageLanguage = 'unknown';
    if (input.language === 'en') {
      language = 'en';
    } else if (input.language === 'ur') {
      language = 'ur';
    }

    const msg: V3CMessage = {
      messageId: randomUUID(),
      channel: input.channel,
      tenantId: input.tenantId ? String(input.tenantId) : '',
      sessionId:
        input.sessionId !== undefined && input.sessionId !== null
          ? String(input.sessionId)
          : '',
      language,
      content: input.content || '',
      metadata: input.metadata || {},
      receivedAt: new Date().toISOString(),
    };

    console.log('[GATEWAY]', JSON.stringify(msg));
    return msg;
  } catch (err: any) {
    console.error('[GATEWAY] ingest error:', err?.message || err);
    return null;
  }
}

export const ChannelGateway = {
  ingest,
};

export default ChannelGateway;
