import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';

export interface WhatsAppSessionContext {
  tenant: any;
  agent: any;
  domain: any;
  visitor: any;
  session: any;
}

/**
 * Resolves tenant, agent, visitor, and persistent visitor session for a WhatsApp sender.
 */
export async function resolveWhatsAppSession(waId: string): Promise<WhatsAppSessionContext | null> {
  const defaultSlug = process.env.WHATSAPP_DEFAULT_TENANT_SLUG || 'test-company-a';

  const tenant = await prisma.tenant.findFirst({
    where: { slug: defaultSlug },
  });

  if (!tenant) {
    console.error(`[WHATSAPP SESSION ERROR] Default tenant not found for slug '${defaultSlug}'.`);
    return null;
  }

  // Find active agent for this tenant
  const agent =
    (await prisma.agent.findFirst({
      where: { tenantId: tenant.id, isActive: true },
      orderBy: { updatedAt: 'desc' },
    })) ||
    (await prisma.agent.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: 'desc' },
    }));

  const domain = await prisma.domain.findFirst({
    where: { tenantId: tenant.id },
  });

  // Find or create persistent Visitor keyed by wa-<waId>
  const visitorSecureId = `wa-${waId}`;
  let visitor = await prisma.visitor.findFirst({
    where: {
      secureId: visitorSecureId,
      tenantId: tenant.id,
    },
  });

  const now = new Date();

  if (!visitor) {
    visitor = await prisma.visitor.create({
      data: {
        secureId: visitorSecureId,
        tenantId: tenant.id,
        domainId: domain?.id || null,
        lastActivity: now,
        updatedAt: now,
      },
    });
  } else {
    await prisma.visitor.update({
      where: { id: visitor.id },
      data: { lastActivity: now },
    });
  }

  // Find latest session for this visitor and tenant, or create one
  let session = await prisma.visitorSession.findFirst({
    where: {
      visitorId: visitor.id,
      tenantId: tenant.id,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    session = await prisma.visitorSession.create({
      data: {
        secureId: `sess-wa-${randomUUID()}`,
        visitorId: visitor.id,
        tenantId: tenant.id,
        domainId: domain?.id || null,
        aiAgentId: agent?.id || null,
        startedAt: now,
        updatedAt: now,
      },
    });
  }

  return {
    tenant,
    agent,
    domain,
    visitor,
    session,
  };
}

export const WhatsAppSessionService = {
  resolveWhatsAppSession,
};

export default WhatsAppSessionService;
