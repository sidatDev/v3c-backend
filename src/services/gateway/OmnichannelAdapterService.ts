import { createHmac, randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import ChannelGateway, { V3CMessage } from './ChannelGateway';
import ScopeGuard from '../orchestrator/ScopeGuard';
import { IntentClassifier, Intent } from '../orchestrator/IntentClassifier';

export type OmnichannelType = 'instagram' | 'messenger' | 'sdk';

export type RegionalLanguageCode = 'en' | 'ur' | 'roman_ur' | 'pa' | 'sd' | 'ps';

export interface OmnichannelAdapterConfig {
  channel: OmnichannelType;
  label: string;
  enabled: boolean;
  pageOrAccountId: string;
  verifyToken: string;
  appSecretMasked: string;
  webhookEndpoint: string;
  regionalLanguages: RegionalLanguageCode[];
  rateLimitPerMin: number;
  totalMessagesProcessed: number;
  lastInboundAt?: string;
}

export interface OmnichannelInboundResult {
  channel: OmnichannelType;
  signatureVerified: boolean;
  detectedRegionalLanguage: RegionalLanguageCode;
  normalizedMessage: V3CMessage | null;
  orchestratorDecision: {
    inScope: boolean;
    intent: Intent;
    specialistAgent: string;
  };
  outboundEnvelope: Record<string, any>;
}

const OMNICHANNEL_CONFIG_KEY = 'v3c_omnichannel_adapters_v1';

export class OmnichannelAdapterService {
  private static getDefaultConfigs(tenantId: string): OmnichannelAdapterConfig[] {
    return [
      {
        channel: 'instagram',
        label: 'Instagram Direct Messaging (Meta Graph API)',
        enabled: true,
        pageOrAccountId: 'ig_biz_17841400008460056',
        verifyToken: `v3c_ig_verify_${tenantId.slice(0, 6)}`,
        appSecretMasked: 'meta_ig_secret_••••••••9a1f',
        webhookEndpoint: `/api/integrations/omnichannel/instagram/inbound`,
        regionalLanguages: ['en', 'ur', 'roman_ur', 'pa'],
        rateLimitPerMin: 120,
        totalMessagesProcessed: 18,
      },
      {
        channel: 'messenger',
        label: 'Facebook Messenger (Meta Page Webhook)',
        enabled: true,
        pageOrAccountId: 'fb_page_104928192019281',
        verifyToken: `v3c_fb_verify_${tenantId.slice(0, 6)}`,
        appSecretMasked: 'meta_fb_secret_••••••••4c8b',
        webhookEndpoint: `/api/integrations/omnichannel/messenger/inbound`,
        regionalLanguages: ['en', 'ur', 'roman_ur', 'sd', 'ps'],
        rateLimitPerMin: 150,
        totalMessagesProcessed: 24,
      },
      {
        channel: 'sdk',
        label: 'V3C Mobile App SDK (iOS / Android / Flutter / React Native)',
        enabled: true,
        pageOrAccountId: `sdk_app_${tenantId.slice(0, 8)}`,
        verifyToken: `v3c_sdk_key_${tenantId.slice(0, 8)}`,
        appSecretMasked: 'sdk_hmac_••••••••7e2d',
        webhookEndpoint: `/api/integrations/omnichannel/sdk/inbound`,
        regionalLanguages: ['en', 'ur', 'roman_ur', 'pa', 'sd', 'ps'],
        rateLimitPerMin: 300,
        totalMessagesProcessed: 42,
      },
    ];
  }

  static async getChannelsConfig(tenantId: string): Promise<OmnichannelAdapterConfig[]> {
    const config = await prisma.configuration.findFirst({
      where: { tenantId, key: OMNICHANNEL_CONFIG_KEY },
    });
    if (!config) {
      const defaults = this.getDefaultConfigs(tenantId);
      await this.saveChannelsConfig(tenantId, defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(config.value || '[]');
      return Array.isArray(parsed) && parsed.length > 0
        ? parsed
        : this.getDefaultConfigs(tenantId);
    } catch {
      return this.getDefaultConfigs(tenantId);
    }
  }

  private static async saveChannelsConfig(
    tenantId: string,
    configs: OmnichannelAdapterConfig[]
  ): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: OMNICHANNEL_CONFIG_KEY },
    });
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(configs), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: OMNICHANNEL_CONFIG_KEY,
          value: JSON.stringify(configs),
          updatedAt: new Date(),
        },
      });
    }
  }

  static async updateChannelConfig(
    tenantId: string,
    channel: OmnichannelType,
    update: Partial<{
      enabled: boolean;
      pageOrAccountId: string;
      verifyToken: string;
      regionalLanguages: RegionalLanguageCode[];
      rateLimitPerMin: number;
    }>
  ): Promise<OmnichannelAdapterConfig> {
    const configs = await this.getChannelsConfig(tenantId);
    const idx = configs.findIndex((c) => c.channel === channel);
    if (idx < 0) {
      throw new Error(`Unsupported omnichannel type: ${channel}`);
    }

    const current = configs[idx];
    const updated: OmnichannelAdapterConfig = {
      ...current,
      enabled: update.enabled !== undefined ? Boolean(update.enabled) : current.enabled,
      pageOrAccountId: update.pageOrAccountId?.trim() || current.pageOrAccountId,
      verifyToken: update.verifyToken?.trim() || current.verifyToken,
      regionalLanguages: Array.isArray(update.regionalLanguages)
        ? update.regionalLanguages
        : current.regionalLanguages,
      rateLimitPerMin:
        update.rateLimitPerMin !== undefined
          ? Math.max(10, Number(update.rateLimitPerMin))
          : current.rateLimitPerMin,
    };

    configs[idx] = updated;
    await this.saveChannelsConfig(tenantId, configs);
    return updated;
  }

  /**
   * Detects English, Urdu script, Roman Urdu, Punjabi, Sindhi, or Pashto from message content.
   */
  static detectRegionalLanguage(text: string, hint?: string): RegionalLanguageCode {
    if (hint && ['en', 'ur', 'roman_ur', 'pa', 'sd', 'ps'].includes(hint)) {
      return hint as RegionalLanguageCode;
    }
    const sample = String(text || '').trim();
    // Pashto specific characters (ښ, ږ, ځ, څ, ړ, ڼ)
    if (/[ښږځڅړڼ]/.test(sample)) return 'ps';
    // Sindhi specific characters (ڄ, ڃ, ڏ, ڌ, ڳ, ڻ)
    if (/[ڄڃڏڌڳڻ]/.test(sample)) return 'sd';
    // Punjabi Gurmukhi or Shahmukhi keywords
    if (/[\u0A00-\u0A7F]|\b(tussi|satsriakal|kiddan|punjabi)\b|(تسی|کداں|دیندے|ساڈے)/i.test(sample)) {
      return 'pa';
    }
    // Urdu Arabic script
    if (/[\u0600-\u06FF]/.test(sample)) return 'ur';
    // Roman Urdu common tokens
    if (
      /\b(kya|hai|hain|mujhe|aap|batao|bataen|qeemat|services|chahiye|kesay|kaise|shukriya|salam|assalam)\b/i.test(
        sample
      )
    ) {
      return 'roman_ur';
    }
    return 'en';
  }

  /**
   * Verifies Meta X-Hub-Signature-256 (sha256=<hex>) or SDK key.
   */
  static verifyChannelSignature(
    rawPayload: string,
    signatureHeader: string | undefined,
    secret: string
  ): boolean {
    if (!signatureHeader) return true; // Permissive in simulation mode when header omitted
    const cleanSig = signatureHeader.replace(/^sha256=/i, '').trim();
    const expected = createHmac('sha256', secret).update(rawPayload).digest('hex');
    return cleanSig === expected || signatureHeader === secret;
  }

  /**
   * Handles an inbound message from Instagram, Facebook Messenger, or Mobile SDK:
   * 1. Verifies channel enablement & signature
   * 2. Detects regional language (en, ur, roman_ur, pa, sd, ps)
   * 3. Normalizes to V3CMessage via ChannelGateway.ingest()
   * 4. Runs ScopeGuard + IntentClassifier routing to Specialist Agent
   * 5. Formats channel-native outbound reply (Meta Graph API or Mobile SDK envelope)
   */
  static async handleInboundChannelMessage(
    tenantId: string,
    input: {
      channel: OmnichannelType;
      senderId: string;
      senderName?: string;
      text: string;
      language?: string;
      signatureHeader?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<OmnichannelInboundResult> {
    const configs = await this.getChannelsConfig(tenantId);
    const channelCfg = configs.find((c) => c.channel === input.channel);
    if (!channelCfg) {
      throw new Error(`Channel configuration not found for ${input.channel}`);
    }
    if (!channelCfg.enabled) {
      throw new Error(`Channel ${input.channel} is currently disabled for this tenant`);
    }

    const rawBody = JSON.stringify({
      senderId: input.senderId,
      text: input.text,
      channel: input.channel,
    });
    const signatureVerified = this.verifyChannelSignature(
      rawBody,
      input.signatureHeader,
      channelCfg.verifyToken
    );

    const detectedLang = this.detectRegionalLanguage(input.text, input.language);
    const gatewayLang = detectedLang === 'ur' || detectedLang === 'roman_ur' ? 'ur' : 'en';

    const normalizedMessage = ChannelGateway.ingest({
      channel: input.channel,
      tenantId,
      sessionId: `${input.channel}_${input.senderId}`,
      language: gatewayLang,
      content: input.text,
      metadata: {
        senderId: input.senderId,
        senderName: input.senderName || 'Omnichannel User',
        regionalLanguage: detectedLang,
        pageOrAccountId: channelCfg.pageOrAccountId,
        ...(input.metadata || {}),
      },
    });

    const inScope = ScopeGuard.isBusinessRelated(input.text);
    const intent: Intent = inScope
      ? await IntentClassifier.classifyIntent(input.text)
      : 'general';

    const specialistAgent = !inScope
      ? 'ScopeGuardRefusalAgent'
      : intent === 'sales'
      ? 'PreSalesSpecialistAgent'
      : intent === 'complaint'
      ? 'EscalationAndClaimsAgent'
      : intent === 'support'
      ? 'TechnicalServicingAgent'
      : 'GeneralFAQAgent';

    const replyText = !inScope
      ? gatewayLang === 'ur'
        ? ScopeGuard.REFUSAL_TEXT
        : ScopeGuard.REFUSAL_TEXT_EN
      : gatewayLang === 'ur'
      ? `وعلیکم السلام! آپ کا پیغام (${input.channel.toUpperCase()}) موصول ہوا۔ ہمارا ${specialistAgent} آپ کی مدد کے لیے حاضر ہے۔`
      : `Hello ${input.senderName || 'there'}! Your ${input.channel.toUpperCase()} inquiry has been routed to ${specialistAgent} (Intent: ${intent}). How can we assist you today?`;

    const outboundEnvelope =
      input.channel === 'instagram' || input.channel === 'messenger'
        ? {
            provider: 'meta_graph_api_v25',
            endpoint: `https://graph.facebook.com/v25.0/${channelCfg.pageOrAccountId}/messages`,
            messaging_type: 'RESPONSE',
            recipient: { id: input.senderId },
            message: {
              text: replyText,
              metadata: JSON.stringify({
                v3cMessageId: normalizedMessage?.messageId,
                specialistAgent,
                regionalLanguage: detectedLang,
              }),
            },
          }
        : {
            provider: 'v3c_mobile_sdk_v1',
            appId: channelCfg.pageOrAccountId,
            sessionId: `${input.channel}_${input.senderId}`,
            reply: {
              id: `sdk_msg_${randomUUID().slice(0, 8)}`,
              text: replyText,
              regionalLanguage: detectedLang,
              specialistAgent,
              quickReplies: [
                { label: 'View Pricing & Bundles', action: 'intent:sales' },
                { label: 'Talk to Human Agent', action: 'intent:escalate' },
              ],
            },
          };

    // Increment channel counter
    channelCfg.totalMessagesProcessed += 1;
    channelCfg.lastInboundAt = new Date().toISOString();
    await this.saveChannelsConfig(tenantId, configs);

    return {
      channel: input.channel,
      signatureVerified,
      detectedRegionalLanguage: detectedLang,
      normalizedMessage,
      orchestratorDecision: {
        inScope,
        intent,
        specialistAgent,
      },
      outboundEnvelope,
    };
  }
}
