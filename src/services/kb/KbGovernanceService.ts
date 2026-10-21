import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error';
import { chunkText, generateEmbedding } from '../../utils/openai';
import { TenantConfigCache } from '../cache/TenantConfigCache';

export type KbApprovalStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED_ACTIVE'
  | 'REJECTED'
  | 'ARCHIVED_EXPIRED';

export type KbUpdateSlaTier =
  | 'MINOR_EDIT_24H'
  | 'NEW_CONTENT_48H'
  | 'EMERGENCY_COMPLIANCE_4H';

export interface KbMetadataTags {
  productLine: string;
  department: string;
  language: 'EN' | 'UR' | 'Bilingual';
  effectiveDate: string;
  expiryDate: string | null;
  slaTier: KbUpdateSlaTier;
}

export interface KbVersionSnapshot {
  versionNumber: number;
  entryId: number;
  title: string;
  content: string;
  authorId: string;
  authorName: string;
  changeType: 'CREATE' | 'EDIT' | 'ROLLBACK';
  slaTier: KbUpdateSlaTier;
  metadata: KbMetadataTags;
  approvalStatus: KbApprovalStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  createdAt: string;
}

export interface KbGovernanceEntryRecord {
  entryId: number;
  title: string;
  currentVersion: number;
  approvalStatus: KbApprovalStatus;
  metadata: KbMetadataTags;
  versions: KbVersionSnapshot[];
  lastWarningSentAt?: string;
  updatedAt: string;
}

interface TenantKbGovernanceState {
  records: Record<number, KbGovernanceEntryRecord>;
}

const GOV_CONFIG_PREFIX = 'kb_governance_state_';

export class KbGovernanceService {
  private static configKey(tenantId: string): string {
    return `${GOV_CONFIG_PREFIX}${tenantId}`;
  }

  private static async loadState(tenantId: string): Promise<TenantKbGovernanceState> {
    const key = this.configKey(tenantId);
    const row = await prisma.configuration.findFirst({ where: { key } });
    if (!row || !row.value) {
      return { records: {} };
    }
    try {
      const parsed = JSON.parse(row.value);
      return {
        records: parsed.records || {},
      };
    } catch {
      return { records: {} };
    }
  }

  private static async saveState(tenantId: string, state: TenantKbGovernanceState): Promise<void> {
    const key = this.configKey(tenantId);
    const serialized = JSON.stringify(state);
    const existing = await prisma.configuration.findFirst({ where: { key } });

    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: serialized, updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          key,
          value: serialized,
          tenantId,
          updatedAt: new Date(),
        },
      });
    }
  }

  private static async rebuildEntryChunks(tenantId: string, entryId: number, content: string): Promise<void> {
    await prisma.documentChunk.deleteMany({ where: { entryId } });
    const chunks = chunkText(content);
    for (const chunk of chunks) {
      const chunkId = randomUUID();
      await prisma.documentChunk.create({
        data: {
          id: chunkId,
          content: chunk,
          entryId,
          tenantId,
        },
      });
      try {
        const embedding = await generateEmbedding(chunk);
        if (embedding && embedding.length > 0) {
          const embeddingSql = `[${embedding.join(',')}]`;
          await prisma.$executeRawUnsafe(
            `UPDATE "DocumentChunk" SET embedding = '${embeddingSql}'::vector WHERE id = '${chunkId}'`
          );
        }
      } catch {
        // Fallback to raw text chunk when vector embedding is unavailable offline
      }
    }
  }

  static async getGovernanceOverview(tenantId: string) {
    const state = await this.loadState(tenantId);
    const dbEntries = await prisma.knowledgeBaseEntry.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
    });

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const enrichedEntries = dbEntries.map((entry) => {
      const gov = state.records[entry.id];
      const metadata: KbMetadataTags = gov?.metadata || {
        productLine: 'General Insurance',
        department: 'Customer Servicing',
        language: 'EN',
        effectiveDate: entry.createdAt.toISOString().slice(0, 10),
        expiryDate: null,
        slaTier: 'MINOR_EDIT_24H',
      };

      const expiryMs = metadata.expiryDate ? new Date(metadata.expiryDate).getTime() : null;
      const isExpired = expiryMs !== null && expiryMs <= now;
      const isExpiringWithin7Days =
        expiryMs !== null && expiryMs > now && expiryMs - now <= sevenDaysMs;

      return {
        entryId: entry.id,
        title: entry.fileName || `KB Entry #${entry.id}`,
        type: entry.type,
        content: entry.content || '',
        enabled: entry.enabled,
        currentVersion: gov?.currentVersion || 1,
        approvalStatus: gov?.approvalStatus || (entry.enabled ? 'APPROVED_ACTIVE' : 'PENDING_APPROVAL'),
        metadata,
        isExpired,
        isExpiringWithin7Days,
        daysUntilExpiry:
          expiryMs !== null ? Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)) : null,
        versions: gov?.versions || [
          {
            versionNumber: 1,
            entryId: entry.id,
            title: entry.fileName || `KB Entry #${entry.id}`,
            content: entry.content || '',
            authorId: 'system',
            authorName: 'System Seed',
            changeType: 'CREATE',
            slaTier: 'MINOR_EDIT_24H',
            metadata,
            approvalStatus: 'APPROVED_ACTIVE',
            createdAt: entry.createdAt.toISOString(),
          },
        ],
        updatedAt: entry.updatedAt.toISOString(),
      };
    });

    const pendingQueue = enrichedEntries.filter((e) => e.approvalStatus === 'PENDING_APPROVAL');
    const expiringSoon = enrichedEntries.filter((e) => e.isExpiringWithin7Days);
    const expiredArchived = enrichedEntries.filter(
      (e) => e.isExpired || e.approvalStatus === 'ARCHIVED_EXPIRED'
    );

    return {
      summary: {
        totalGovernedEntries: enrichedEntries.length,
        pendingApprovals: pendingQueue.length,
        expiringWithin7Days: expiringSoon.length,
        expiredArchivedCount: expiredArchived.length,
      },
      entries: enrichedEntries,
      pendingQueue,
      expiringSoon,
      expiredArchived,
    };
  }

  static async submitEntryChange(
    tenantId: string,
    author: { id: string; name?: string },
    input: {
      entryId?: number;
      title: string;
      content: string;
      productLine?: string;
      department?: string;
      language?: 'EN' | 'UR' | 'Bilingual';
      effectiveDate?: string;
      expiryDate?: string | null;
      slaTier?: KbUpdateSlaTier;
      autoApprove?: boolean;
    }
  ) {
    if (!input.title?.trim() || !input.content?.trim()) {
      throw new AppError('Title and content are required for KB submission', 400);
    }

    const state = await this.loadState(tenantId);
    const nowIso = new Date().toISOString();

    const metadata: KbMetadataTags = {
      productLine: input.productLine?.trim() || 'General Insurance',
      department: input.department?.trim() || 'Policy Servicing',
      language: input.language || 'EN',
      effectiveDate: input.effectiveDate || nowIso.slice(0, 10),
      expiryDate: input.expiryDate ? input.expiryDate : null,
      slaTier: input.slaTier || 'MINOR_EDIT_24H',
    };

    const approvalStatus: KbApprovalStatus = input.autoApprove
      ? 'APPROVED_ACTIVE'
      : 'PENDING_APPROVAL';

    let dbEntry;
    let changeType: 'CREATE' | 'EDIT' = 'CREATE';

    if (input.entryId) {
      const existing = await prisma.knowledgeBaseEntry.findFirst({
        where: { id: input.entryId, tenantId },
      });
      if (!existing) {
        throw new AppError('Target KB entry not found for edit', 404);
      }
      changeType = 'EDIT';

      // Only overwrite active content immediately if autoApprove=true; otherwise keep entry pending approval
      dbEntry = await prisma.knowledgeBaseEntry.update({
        where: { id: existing.id },
        data: {
          fileName: input.title.trim(),
          ...(input.autoApprove ? { content: input.content, enabled: true } : {}),
          updatedAt: new Date(),
        },
      });
    } else {
      dbEntry = await prisma.knowledgeBaseEntry.create({
        data: {
          tenantId,
          type: 'CUSTOM',
          fileName: input.title.trim(),
          content: input.content,
          status: input.autoApprove ? 'COMPLETED' : 'PENDING_APPROVAL',
          enabled: Boolean(input.autoApprove),
          updatedAt: new Date(),
        },
      });
    }

    const existingGov = state.records[dbEntry.id];
    const nextVersionNumber = existingGov ? existingGov.currentVersion + 1 : 1;

    const snapshot: KbVersionSnapshot = {
      versionNumber: nextVersionNumber,
      entryId: dbEntry.id,
      title: input.title.trim(),
      content: input.content,
      authorId: author.id,
      authorName: author.name || 'Company Admin',
      changeType,
      slaTier: metadata.slaTier,
      metadata,
      approvalStatus,
      ...(input.autoApprove
        ? {
            reviewedBy: author.name || 'Company Admin',
            reviewedAt: nowIso,
            reviewNotes: 'Auto-approved on submission',
          }
        : {}),
      createdAt: nowIso,
    };

    const versions = existingGov ? [snapshot, ...existingGov.versions] : [snapshot];

    state.records[dbEntry.id] = {
      entryId: dbEntry.id,
      title: input.title.trim(),
      currentVersion: nextVersionNumber,
      approvalStatus,
      metadata,
      versions,
      updatedAt: nowIso,
    };

    await this.saveState(tenantId, state);

    if (input.autoApprove) {
      await this.rebuildEntryChunks(tenantId, dbEntry.id, input.content);
      TenantConfigCache.invalidate(tenantId);
    }

    return state.records[dbEntry.id];
  }

  static async approveOrRejectEntry(
    tenantId: string,
    reviewer: { id: string; name?: string },
    entryId: number,
    decision: 'APPROVE' | 'REJECT',
    reviewNotes?: string
  ) {
    const state = await this.loadState(tenantId);
    const gov = state.records[entryId];
    if (!gov) {
      throw new AppError('Governed KB entry not found', 404);
    }

    const latestSnapshot = gov.versions[0];
    if (!latestSnapshot) {
      throw new AppError('No version snapshot found for this KB entry', 400);
    }

    const nowIso = new Date().toISOString();
    const nextStatus: KbApprovalStatus =
      decision === 'APPROVE' ? 'APPROVED_ACTIVE' : 'REJECTED';

    latestSnapshot.approvalStatus = nextStatus;
    latestSnapshot.reviewedBy = reviewer.name || reviewer.id;
    latestSnapshot.reviewedAt = nowIso;
    latestSnapshot.reviewNotes =
      reviewNotes || (decision === 'APPROVE' ? 'Approved by Company Admin' : 'Rejected by Company Admin');

    gov.approvalStatus = nextStatus;
    gov.updatedAt = nowIso;

    if (decision === 'APPROVE') {
      await prisma.knowledgeBaseEntry.update({
        where: { id: entryId },
        data: {
          fileName: latestSnapshot.title,
          content: latestSnapshot.content,
          status: 'COMPLETED',
          enabled: true,
          updatedAt: new Date(),
        },
      });
      await this.rebuildEntryChunks(tenantId, entryId, latestSnapshot.content);
      TenantConfigCache.invalidate(tenantId);
    } else {
      await prisma.knowledgeBaseEntry.update({
        where: { id: entryId },
        data: {
          status: 'REJECTED',
          enabled: false,
          updatedAt: new Date(),
        },
      });
      TenantConfigCache.invalidate(tenantId);
    }

    await this.saveState(tenantId, state);
    return gov;
  }

  static async rollbackEntryVersion(
    tenantId: string,
    actor: { id: string; name?: string },
    entryId: number,
    targetVersionNumber: number
  ) {
    const state = await this.loadState(tenantId);
    const gov = state.records[entryId];
    if (!gov) {
      throw new AppError('Governed KB entry not found for rollback', 404);
    }

    const targetSnapshot = gov.versions.find((v) => v.versionNumber === targetVersionNumber);
    if (!targetSnapshot) {
      throw new AppError(`Version v${targetVersionNumber} not found for entry #${entryId}`, 404);
    }

    const nowIso = new Date().toISOString();
    const nextVersionNumber = gov.currentVersion + 1;

    const rollbackSnapshot: KbVersionSnapshot = {
      versionNumber: nextVersionNumber,
      entryId,
      title: targetSnapshot.title,
      content: targetSnapshot.content,
      authorId: actor.id,
      authorName: actor.name || 'Company Admin',
      changeType: 'ROLLBACK',
      slaTier: 'EMERGENCY_COMPLIANCE_4H',
      metadata: targetSnapshot.metadata,
      approvalStatus: 'APPROVED_ACTIVE',
      reviewedBy: actor.name || 'Company Admin',
      reviewedAt: nowIso,
      reviewNotes: `1-Click Rollback to v${targetVersionNumber}`,
      createdAt: nowIso,
    };

    gov.currentVersion = nextVersionNumber;
    gov.title = targetSnapshot.title;
    gov.metadata = targetSnapshot.metadata;
    gov.approvalStatus = 'APPROVED_ACTIVE';
    gov.versions = [rollbackSnapshot, ...gov.versions];
    gov.updatedAt = nowIso;

    await prisma.knowledgeBaseEntry.update({
      where: { id: entryId },
      data: {
        fileName: targetSnapshot.title,
        content: targetSnapshot.content,
        status: 'COMPLETED',
        enabled: true,
        updatedAt: new Date(),
      },
    });

    await this.rebuildEntryChunks(tenantId, entryId, targetSnapshot.content);
    await this.saveState(tenantId, state);
    TenantConfigCache.invalidate(tenantId);

    return {
      rolledBackToVersion: targetVersionNumber,
      newVersionNumber: nextVersionNumber,
      record: gov,
    };
  }

  static async runExpirySweep(tenantId: string) {
    const state = await this.loadState(tenantId);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const archivedEntryIds: number[] = [];
    const warnedEntryIds: number[] = [];

    for (const [idStr, gov] of Object.entries(state.records)) {
      const entryId = Number(idStr);
      const expiryStr = gov.metadata?.expiryDate;
      if (!expiryStr) continue;

      const expiryMs = new Date(expiryStr).getTime();
      if (isNaN(expiryMs)) continue;

      if (expiryMs <= now && gov.approvalStatus !== 'ARCHIVED_EXPIRED') {
        gov.approvalStatus = 'ARCHIVED_EXPIRED';
        gov.updatedAt = new Date().toISOString();

        await prisma.knowledgeBaseEntry.updateMany({
          where: { id: entryId, tenantId },
          data: {
            enabled: false,
            status: 'ARCHIVED_EXPIRED',
            updatedAt: new Date(),
          },
        });
        await prisma.documentChunk.deleteMany({ where: { entryId } });
        archivedEntryIds.push(entryId);
      } else if (expiryMs > now && expiryMs - now <= sevenDaysMs) {
        const daysLeft = Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000));
        await prisma.notification.create({
          data: {
            id: randomUUID(),
            tenantId,
            type: 'kb_expiry_warning',
            title: `KB Content Expiring in ${daysLeft} Day(s)`,
            message: `Knowledge Base entry "${gov.title}" (#${entryId}) will expire on ${expiryStr} and auto-archive unless renewed.`,
            isRead: false,
            metadata: {
              entryId,
              title: gov.title,
              expiryDate: expiryStr,
              daysLeft,
            } as any,
          },
        });
        gov.lastWarningSentAt = new Date().toISOString();
        warnedEntryIds.push(entryId);
      }
    }

    await this.saveState(tenantId, state);
    if (archivedEntryIds.length > 0) {
      TenantConfigCache.invalidate(tenantId);
    }

    return {
      archivedCount: archivedEntryIds.length,
      archivedEntryIds,
      warnedCount: warnedEntryIds.length,
      warnedEntryIds,
      sweptAt: new Date().toISOString(),
    };
  }

  static async exportStructuredKbJson(tenantId: string) {
    const overview = await this.getGovernanceOverview(tenantId);
    const knowledgeBases = await prisma.knowledgeBase.findMany({
      where: { tenantId },
      include: { documents: true },
    });

    return {
      exportedAt: new Date().toISOString(),
      tenantId,
      blueprintCompliance: 'Section 5.3 — Full Structured KB JSON Export (Client Ownership)',
      summary: overview.summary,
      specialistKnowledgeBases: knowledgeBases,
      governedEntriesWithVersionHistory: overview.entries,
    };
  }
}
