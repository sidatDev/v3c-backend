import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { XPayService } from './XPayService';

export async function recordUsage(
  tenantId: string,
  agentId: string | null,
  model: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  if (!tenantId) {
    return;
  }

  const safePrompt = Math.max(0, Number(promptTokens) || 0);
  const safeCompletion = Math.max(0, Number(completionTokens) || 0);
  const totalTokens = safePrompt + safeCompletion;

  try {
    await prisma.usage.create({
      data: {
        id: randomUUID(),
        tenantId,
        agentId: agentId || null,
        model: model || 'gpt-4o-mini',
        promptTokens: safePrompt,
        completionTokens: safeCompletion,
        totalTokens,
        createdAt: new Date(),
      },
    });
    console.log(`[METERING] Recorded ${totalTokens} tokens for tenant ${tenantId} (model: ${model})`);
    XPayService.evaluateThresholdAlerts(tenantId).catch((alertErr) => {
      console.warn(`[METERING] Alert evaluation warning for tenant ${tenantId}:`, alertErr?.message || alertErr);
    });
  } catch (err: any) {
    console.warn(`[METERING] Failed to record usage for tenant ${tenantId}:`, err?.message || err);
  }
}

export class MeteringService {
  static recordUsage = recordUsage;
}

export default MeteringService;
