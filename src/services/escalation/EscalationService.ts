/**
 * EscalationService.ts
 * Manages escalation and human handoff tickets for complaints and explicit agent requests.
 * Enforces strict multi-tenant isolation.
 */

import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error';
import { RealtimeHub } from '../realtime/RealtimeHub';

export interface EscalationRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  visitorId: string | null;
  reason: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class EscalationService {
  /**
   * Creates a new escalation ticket for a tenant session.
   */
  static async createEscalation(
    tenantId: string,
    sessionId: string,
    visitorId: string | null = null,
    reason: string = 'complaint'
  ): Promise<EscalationRecord> {
    if (!tenantId) {
      throw new AppError('tenantId is required to create an escalation', 400);
    }

    const escalation = await prisma.escalation.create({
      data: {
        id: randomUUID(),
        tenantId,
        sessionId: sessionId || 'unknown-session',
        visitorId: visitorId || null,
        reason,
        status: 'pending',
        notes: null,
        updatedAt: new Date()
      }
    });

    console.log(`[ESCALATION] Created ticket ${escalation.id} for tenant ${tenantId} (reason: ${reason})`);
    RealtimeHub.broadcast(tenantId, 'escalation_created', {
      id: escalation.id,
      sessionId: escalation.sessionId,
      visitorId: escalation.visitorId,
      reason: escalation.reason,
      status: escalation.status,
      createdAt: escalation.createdAt,
    });
    return escalation;
  }

  /**
   * Retrieves all escalations for a specific tenant ordered by createdAt desc.
   */
  static async getEscalations(tenantId: string): Promise<EscalationRecord[]> {
    if (!tenantId) {
      return [];
    }

    return prisma.escalation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Updates an escalation's status and notes with strict tenant ownership validation.
   */
  static async updateEscalationStatus(
    id: string,
    tenantId: string,
    status: string,
    notes?: string
  ): Promise<EscalationRecord> {
    const existing = await prisma.escalation.findUnique({
      where: { id }
    });

    if (!existing) {
      throw new AppError('Escalation ticket not found', 404);
    }

    if (existing.tenantId !== tenantId) {
      throw new AppError('Forbidden: Cannot modify escalation belonging to another tenant', 403);
    }

    const updateData: any = {
      status,
      updatedAt: new Date()
    };

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    return prisma.escalation.update({
      where: { id },
      data: updateData
    });
  }
}

export const createEscalation = EscalationService.createEscalation;
export const updateEscalationStatus = EscalationService.updateEscalationStatus;
export const getEscalations = EscalationService.getEscalations;
export default EscalationService;
