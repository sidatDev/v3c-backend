import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { WebhookEngineService } from '../webhooks/WebhookEngineService';

export type DncSource = 'verbal' | 'dtmf' | 'manual';

export interface DncEntry {
  phone: string;
  source: DncSource;
  reason: string;
  addedAt: string;
}

export type ContactDisposition =
  | 'ready'
  | 'answered'
  | 'no_answer'
  | 'busy'
  | 'voicemail'
  | 'retry_scheduled'
  | 'dnc_requested'
  | 'dnc_scrubbed'
  | 'max_attempts'
  | 'invalid';

export interface CampaignContact {
  id: string;
  name: string;
  rawPhone: string;
  e164Phone: string;
  segment?: string;
  disposition: ContactDisposition;
  attempts: number;
  lastDialedAt?: string;
  inCallEvent?: 'lead_captured' | 'promise_to_pay' | 'feedback_received' | 'call_completed' | 'dnc_opt_out';
  notes?: string;
}

export interface CampaignIngestionStats {
  totalUploaded: number;
  validReady: number;
  duplicatesRemoved: number;
  dncScrubbed: number;
  invalidNumbers: number;
}

export interface OutboundCampaign {
  id: string;
  name: string;
  type: 'lead_outreach' | 'payment_reminder' | 'csat_followup' | 'renewal_notice';
  voicePersona: 'Alloy' | 'Shimmer' | 'Echo' | 'Urdu-Female-PK';
  callerId: string;
  callingWindow: string;
  concurrencyLimit: number;
  maxRetries: number;
  status: 'scheduled' | 'running' | 'completed' | 'paused';
  scriptPrompt: string;
  ingestionStats: CampaignIngestionStats;
  contacts: CampaignContact[];
  createdAt: string;
  updatedAt: string;
}

const CAMPAIGNS_CONFIG_KEY = 'v3c_outbound_campaigns_v1';
const DNC_CONFIG_KEY = 'v3c_dnc_registry_v1';

export class OutboundCampaignService {
  /**
   * Normalizes Pakistan (03xx, 923xx) and international numbers to strict E.164 (+923xxxxxxxxx).
   * Returns { valid, e164 }
   */
  static normalizeE164(raw: string): { valid: boolean; e164: string } {
    const cleaned = String(raw || '').replace(/[\s\-().]/g, '');
    if (!cleaned) return { valid: false, e164: '' };

    let normalized = cleaned;
    if (normalized.startsWith('00')) {
      normalized = '+' + normalized.slice(2);
    } else if (/^03\d{9}$/.test(normalized)) {
      // Pakistan local mobile format 03XXXXXXXXX -> +923XXXXXXXXX
      normalized = '+92' + normalized.slice(1);
    } else if (/^923\d{9}$/.test(normalized)) {
      normalized = '+' + normalized;
    } else if (!normalized.startsWith('+') && /^\d{10,15}$/.test(normalized)) {
      normalized = '+' + normalized;
    }

    const isValid = /^\+[1-9]\d{9,14}$/.test(normalized);
    return { valid: isValid, e164: isValid ? normalized : cleaned };
  }

  private static getDefaultDncList(): DncEntry[] {
    const now = new Date().toISOString();
    return [
      {
        phone: '+923009998888',
        source: 'verbal',
        reason: 'Customer requested Do-Not-Call during previous voice interaction',
        addedAt: now,
      },
      {
        phone: '+923210001122',
        source: 'dtmf',
        reason: 'Pressed 9 (DTMF opt-out) during promotional campaign',
        addedAt: now,
      },
    ];
  }

  private static getDefaultCampaigns(): OutboundCampaign[] {
    const now = new Date().toISOString();
    return [
      {
        id: 'cmp_default_renewal_q4',
        name: 'Q4 Enterprise Policy & Subscription Renewal Callout',
        type: 'renewal_notice',
        voicePersona: 'Urdu-Female-PK',
        callerId: '+922138899000',
        callingWindow: '09:00 - 20:00 PKT',
        concurrencyLimit: 4,
        maxRetries: 3,
        status: 'scheduled',
        scriptPrompt:
          'Assalam-o-Alaikum {{name}}, I am calling from V3C AI Customer Care regarding your upcoming renewal. Would you like me to send your renewal link on WhatsApp?',
        ingestionStats: {
          totalUploaded: 5,
          validReady: 4,
          duplicatesRemoved: 0,
          dncScrubbed: 1,
          invalidNumbers: 0,
        },
        contacts: [
          {
            id: 'cnt_1',
            name: 'Ahmed Raza',
            rawPhone: '03001112233',
            e164Phone: '+923001112233',
            segment: 'Enterprise',
            disposition: 'ready',
            attempts: 0,
          },
          {
            id: 'cnt_2',
            name: 'Sara Khan',
            rawPhone: '+923334445566',
            e164Phone: '+923334445566',
            segment: 'SMB',
            disposition: 'ready',
            attempts: 0,
          },
          {
            id: 'cnt_3',
            name: 'Bilal Tariq',
            rawPhone: '03215556677',
            e164Phone: '+923215556677',
            segment: 'Enterprise',
            disposition: 'ready',
            attempts: 0,
          },
          {
            id: 'cnt_4',
            name: 'Zainab Ali',
            rawPhone: '03457778899',
            e164Phone: '+923457778899',
            segment: 'Mid-Market',
            disposition: 'ready',
            attempts: 0,
          },
          {
            id: 'cnt_5',
            name: 'Opted Out User',
            rawPhone: '03009998888',
            e164Phone: '+923009998888',
            segment: 'SMB',
            disposition: 'dnc_scrubbed',
            attempts: 0,
            notes: 'Scrubbed against Company DNC list (+923009998888)',
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  static async getDncList(tenantId: string): Promise<DncEntry[]> {
    const config = await prisma.configuration.findFirst({
      where: { tenantId, key: DNC_CONFIG_KEY },
    });
    if (!config) {
      const defaults = this.getDefaultDncList();
      await this.saveDncList(tenantId, defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(config.value || '[]');
      return Array.isArray(parsed) ? parsed : this.getDefaultDncList();
    } catch {
      return this.getDefaultDncList();
    }
  }

  private static async saveDncList(tenantId: string, list: DncEntry[]): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: DNC_CONFIG_KEY },
    });
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(list), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: DNC_CONFIG_KEY,
          value: JSON.stringify(list),
          updatedAt: new Date(),
        },
      });
    }
  }

  static async getCampaigns(tenantId: string): Promise<OutboundCampaign[]> {
    const config = await prisma.configuration.findFirst({
      where: { tenantId, key: CAMPAIGNS_CONFIG_KEY },
    });
    if (!config) {
      const defaults = this.getDefaultCampaigns();
      await this.saveCampaigns(tenantId, defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(config.value || '[]');
      return Array.isArray(parsed) ? parsed : this.getDefaultCampaigns();
    } catch {
      return this.getDefaultCampaigns();
    }
  }

  private static async saveCampaigns(tenantId: string, campaigns: OutboundCampaign[]): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: CAMPAIGNS_CONFIG_KEY },
    });
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(campaigns), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: CAMPAIGNS_CONFIG_KEY,
          value: JSON.stringify(campaigns),
          updatedAt: new Date(),
        },
      });
    }
  }

  static async listCampaignsAndDnc(tenantId: string) {
    const [campaigns, dncList] = await Promise.all([
      this.getCampaigns(tenantId),
      this.getDncList(tenantId),
    ]);
    return { campaigns, dncList };
  }

  /**
   * Adds a phone number to the Company DNC Registry and automatically scrubs any queued contacts
   * across active/scheduled campaigns for this tenant.
   */
  static async addDncEntry(
    tenantId: string,
    input: { phone: string; source?: DncSource; reason?: string }
  ): Promise<{ entry: DncEntry; scrubbedCampaignContacts: number }> {
    const { valid, e164 } = this.normalizeE164(input.phone);
    const normalizedPhone = valid ? e164 : input.phone.trim();

    const dncList = await this.getDncList(tenantId);
    const existingIdx = dncList.findIndex((d) => d.phone === normalizedPhone);
    const entry: DncEntry = {
      phone: normalizedPhone,
      source: input.source || 'manual',
      reason: input.reason || 'Added to Company DNC Registry',
      addedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      dncList[existingIdx] = entry;
    } else {
      dncList.unshift(entry);
    }
    await this.saveDncList(tenantId, dncList);

    // Re-validate running/scheduled campaigns and scrub matching contacts
    const campaigns = await this.getCampaigns(tenantId);
    let scrubbedCampaignContacts = 0;
    for (const cmp of campaigns) {
      for (const c of cmp.contacts) {
        if (
          c.e164Phone === normalizedPhone &&
          (c.disposition === 'ready' || c.disposition === 'retry_scheduled')
        ) {
          c.disposition = 'dnc_scrubbed';
          c.notes = `Auto-scrubbed by DNC update (${entry.source.toUpperCase()})`;
          cmp.ingestionStats.dncScrubbed += 1;
          cmp.ingestionStats.validReady = Math.max(0, cmp.ingestionStats.validReady - 1);
          scrubbedCampaignContacts += 1;
        }
      }
    }
    if (scrubbedCampaignContacts > 0) {
      await this.saveCampaigns(tenantId, campaigns);
    }

    return { entry, scrubbedCampaignContacts };
  }

  static async removeDncEntry(tenantId: string, phone: string): Promise<void> {
    const { valid, e164 } = this.normalizeE164(phone);
    const target = valid ? e164 : phone.trim();
    const dncList = await this.getDncList(tenantId);
    const filtered = dncList.filter((d) => d.phone !== target && d.phone !== phone.trim());
    await this.saveDncList(tenantId, filtered);
  }

  /**
   * Parses CSV contacts (Name,Phone,Segment), checks E.164, deduplicates within upload,
   * and scrubs against the Company DNC list.
   */
  static async createCampaignWithCsv(
    tenantId: string,
    input: {
      name: string;
      type?: OutboundCampaign['type'];
      voicePersona?: OutboundCampaign['voicePersona'];
      callerId?: string;
      callingWindow?: string;
      concurrencyLimit?: number;
      maxRetries?: number;
      scriptPrompt?: string;
      csvContent: string;
    }
  ): Promise<OutboundCampaign> {
    const dncList = await this.getDncList(tenantId);
    const dncSet = new Set(dncList.map((d) => d.phone));

    const lines = String(input.csvContent || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const seenPhones = new Set<string>();
    const contacts: CampaignContact[] = [];
    const stats: CampaignIngestionStats = {
      totalUploaded: 0,
      validReady: 0,
      duplicatesRemoved: 0,
      dncScrubbed: 0,
      invalidNumbers: 0,
    };

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      // Skip header line if detected
      if (
        i === 0 &&
        cols.some((c) => /^(name|phone|mobile|contact|number)$/i.test(c))
      ) {
        continue;
      }

      stats.totalUploaded += 1;
      // Support either "Name,Phone,Segment" or single-column "Phone"
      const hasMultipleCols = cols.length >= 2;
      const name = hasMultipleCols ? cols[0] || `Contact #${stats.totalUploaded}` : `Contact #${stats.totalUploaded}`;
      const rawPhone = hasMultipleCols ? cols[1] || '' : cols[0] || '';
      const segment = cols[2] || 'General';

      const { valid, e164 } = this.normalizeE164(rawPhone);
      if (!valid) {
        stats.invalidNumbers += 1;
        contacts.push({
          id: `cnt_${randomUUID().slice(0, 8)}`,
          name,
          rawPhone,
          e164Phone: rawPhone,
          segment,
          disposition: 'invalid',
          attempts: 0,
          notes: 'Failed E.164 phone validation',
        });
        continue;
      }

      if (seenPhones.has(e164)) {
        stats.duplicatesRemoved += 1;
        continue;
      }
      seenPhones.add(e164);

      if (dncSet.has(e164)) {
        stats.dncScrubbed += 1;
        contacts.push({
          id: `cnt_${randomUUID().slice(0, 8)}`,
          name,
          rawPhone,
          e164Phone: e164,
          segment,
          disposition: 'dnc_scrubbed',
          attempts: 0,
          notes: 'Scrubbed against Company DNC Registry prior to dialing',
        });
        continue;
      }

      stats.validReady += 1;
      contacts.push({
        id: `cnt_${randomUUID().slice(0, 8)}`,
        name,
        rawPhone,
        e164Phone: e164,
        segment,
        disposition: 'ready',
        attempts: 0,
      });
    }

    const now = new Date().toISOString();
    const campaign: OutboundCampaign = {
      id: `cmp_${randomUUID().slice(0, 10)}`,
      name: input.name.trim(),
      type: input.type || 'lead_outreach',
      voicePersona: input.voicePersona || 'Urdu-Female-PK',
      callerId: input.callerId?.trim() || '+922138899000',
      callingWindow: input.callingWindow?.trim() || '09:00 - 20:00 PKT',
      concurrencyLimit: Math.min(10, Math.max(1, Number(input.concurrencyLimit || 3))),
      maxRetries: Math.min(5, Math.max(1, Number(input.maxRetries || 3))),
      status: 'scheduled',
      scriptPrompt:
        input.scriptPrompt?.trim() ||
        'Assalam-o-Alaikum {{name}}, calling from V3C AI Voice Team. Do you have 30 seconds for an update?',
      ingestionStats: stats,
      contacts,
      createdAt: now,
      updatedAt: now,
    };

    const campaigns = await this.getCampaigns(tenantId);
    campaigns.unshift(campaign);
    await this.saveCampaigns(tenantId, campaigns);

    return campaign;
  }

  /**
   * Executes a concurrency-limited dialer pass across eligible contacts (`ready` or `retry_scheduled`).
   * Assigns realistic dispositions (`answered`, `no_answer`, `busy`, `voicemail`, `dnc_requested`),
   * applies retry rules, updates Company DNC on `dnc_requested`, and triggers webhooks + notifications.
   */
  static async runDialerBatch(
    tenantId: string,
    campaignId: string,
    options?: { forceDispositions?: ContactDisposition[] }
  ) {
    const campaigns = await this.getCampaigns(tenantId);
    const campaign = campaigns.find((c) => c.id === campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const eligible = campaign.contacts.filter(
      (c) => c.disposition === 'ready' || c.disposition === 'retry_scheduled'
    );

    const batch = eligible.slice(0, campaign.concurrencyLimit);
    const batchResults: Array<{
      contactId: string;
      name: string;
      e164Phone: string;
      disposition: ContactDisposition;
      attempts: number;
      inCallEvent?: string;
    }> = [];

    const outcomeCycle: ContactDisposition[] = options?.forceDispositions || [
      'answered',
      'no_answer',
      'answered',
      'voicemail',
      'dnc_requested',
      'busy',
    ];

    for (let i = 0; i < batch.length; i++) {
      const contact = batch[i];
      contact.attempts += 1;
      contact.lastDialedAt = new Date().toISOString();

      const rawOutcome = outcomeCycle[i % outcomeCycle.length];

      if (rawOutcome === 'answered') {
        contact.disposition = 'answered';
        contact.inCallEvent =
          campaign.type === 'payment_reminder'
            ? 'promise_to_pay'
            : campaign.type === 'csat_followup'
            ? 'feedback_received'
            : 'lead_captured';
        contact.notes = `Connected with AI Voice (${campaign.voicePersona}) — event: ${contact.inCallEvent}`;

        // Emit webhook fan-out for answered campaign call
        await WebhookEngineService.dispatchOutboundEvent({
          tenantId,
          event: contact.inCallEvent === 'lead_captured' ? 'lead.captured' : 'conversation.resolved',
          payload: {
            campaignId: campaign.id,
            campaignName: campaign.name,
            contactName: contact.name,
            phone: contact.e164Phone,
            inCallEvent: contact.inCallEvent,
          },
        }).catch(() => undefined);
      } else if (rawOutcome === 'dnc_requested') {
        contact.disposition = 'dnc_requested';
        contact.inCallEvent = 'dnc_opt_out';
        contact.notes = 'Customer requested DNC during call; added to Company DNC Registry';
        await this.addDncEntry(tenantId, {
          phone: contact.e164Phone,
          source: 'verbal',
          reason: `Opted out during campaign "${campaign.name}"`,
        });
      } else if (rawOutcome === 'no_answer' || rawOutcome === 'busy' || rawOutcome === 'voicemail') {
        if (contact.attempts >= campaign.maxRetries) {
          contact.disposition = 'max_attempts';
          contact.notes = `Reached max retries (${campaign.maxRetries}) after ${rawOutcome}; routed to Human Follow-Up Queue`;
          await prisma.notification
            .create({
              data: {
                id: randomUUID(),
                tenantId,
                type: 'WARNING',
                title: `Campaign Human Follow-Up Required: ${contact.name}`,
                message: `Contact ${contact.e164Phone} in campaign "${campaign.name}" reached max attempts (${campaign.maxRetries}). Assigned to Human Follow-Up Queue.`,
              },
            })
            .catch(() => undefined);
        } else {
          contact.disposition = 'retry_scheduled';
          contact.notes = `Outcome: ${rawOutcome} (Attempt ${contact.attempts}/${campaign.maxRetries}) — retry scheduled`;
        }
      }

      batchResults.push({
        contactId: contact.id,
        name: contact.name,
        e164Phone: contact.e164Phone,
        disposition: contact.disposition,
        attempts: contact.attempts,
        inCallEvent: contact.inCallEvent,
      });
    }

    const remainingEligible = campaign.contacts.filter(
      (c) => c.disposition === 'ready' || c.disposition === 'retry_scheduled'
    ).length;

    campaign.status = remainingEligible === 0 ? 'completed' : 'running';
    campaign.updatedAt = new Date().toISOString();
    await this.saveCampaigns(tenantId, campaigns);

    return {
      campaignId: campaign.id,
      campaignStatus: campaign.status,
      dialedCount: batchResults.length,
      remainingQueue: remainingEligible,
      batchResults,
      campaign,
    };
  }
}
