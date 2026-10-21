import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { XPayService } from './XPayService';

export type DiscountType =
  | 'percentage'
  | 'volume'
  | 'loyalty'
  | 'group_code'
  | 'trial_credit';

export interface DiscountRule {
  id: string;
  code: string;
  type: DiscountType;
  percentageOff: number;
  flatAmountOffPkr: number;
  bonusTrialTokens: number;
  minOrderPkr: number;
  validFrom: string;
  validUntil: string;
  appliedBy: string;
  notes: string;
  active: boolean;
}

export interface EnterpriseInvoiceRecord {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  requestedTokens: number;
  grossAmountPkr: number;
  discountAppliedPkr: number;
  netAmountPkr: number;
  discountCode?: string;
  status: 'pending_review' | 'invoiced' | 'paid_credited';
  requestedBy: string;
  approvedBy?: string;
  approvalReason?: string;
  notes?: string;
  createdAt: string;
  creditedAt?: string;
}

const DISCOUNTS_CONFIG_KEY = 'v3c_billing_discounts_v1';
const INVOICES_CONFIG_KEY = 'v3c_enterprise_invoices_v1';
const SELF_SERVE_THRESHOLD_PKR = 100_000;

export class DiscountAndInvoiceService {
  private static getDefaultDiscounts(): DiscountRule[] {
    const now = new Date();
    const nextQuarter = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    return [
      {
        id: 'dsc_pct_sidat15',
        code: 'SIDAT15',
        type: 'percentage',
        percentageOff: 15,
        flatAmountOffPkr: 0,
        bonusTrialTokens: 0,
        minOrderPkr: 0,
        validFrom: now.toISOString(),
        validUntil: nextQuarter.toISOString(),
        appliedBy: 'Sidat Super User',
        notes: '15% promotional discount on token top-ups for Q4',
        active: true,
      },
      {
        id: 'dsc_vol_100k',
        code: 'VOLUME10',
        type: 'volume',
        percentageOff: 10,
        flatAmountOffPkr: 0,
        bonusTrialTokens: 0,
        minOrderPkr: 100_000,
        validFrom: now.toISOString(),
        validUntil: nextQuarter.toISOString(),
        appliedBy: 'Sidat Super User',
        notes: 'Stepped 10% volume discount on orders >= PKR 100,000',
        active: true,
      },
      {
        id: 'dsc_grp_holding',
        code: 'GROUP20',
        type: 'group_code',
        percentageOff: 20,
        flatAmountOffPkr: 0,
        bonusTrialTokens: 0,
        minOrderPkr: 50_000,
        validFrom: now.toISOString(),
        validUntil: nextQuarter.toISOString(),
        appliedBy: 'Super Group Admin',
        notes: '20% conglomerate subsidiary group discount code',
        active: true,
      },
    ];
  }

  static async getDiscounts(tenantId: string): Promise<DiscountRule[]> {
    const cfg = await prisma.configuration.findFirst({
      where: { tenantId, key: DISCOUNTS_CONFIG_KEY },
    });
    if (!cfg) {
      const defaults = this.getDefaultDiscounts();
      await this.saveDiscounts(tenantId, defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(cfg.value || '[]');
      return Array.isArray(parsed) ? parsed : this.getDefaultDiscounts();
    } catch {
      return this.getDefaultDiscounts();
    }
  }

  private static async saveDiscounts(tenantId: string, rules: DiscountRule[]): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: DISCOUNTS_CONFIG_KEY },
    });
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(rules), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: DISCOUNTS_CONFIG_KEY,
          value: JSON.stringify(rules),
          updatedAt: new Date(),
        },
      });
    }
  }

  static async getInvoices(tenantId: string): Promise<EnterpriseInvoiceRecord[]> {
    const cfg = await prisma.configuration.findFirst({
      where: { tenantId, key: INVOICES_CONFIG_KEY },
    });
    if (!cfg) return [];
    try {
      const parsed = JSON.parse(cfg.value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private static async saveInvoices(
    tenantId: string,
    invoices: EnterpriseInvoiceRecord[]
  ): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: INVOICES_CONFIG_KEY },
    });
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(invoices), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: INVOICES_CONFIG_KEY,
          value: JSON.stringify(invoices),
          updatedAt: new Date(),
        },
      });
    }
  }

  static async getOverview(tenantId: string) {
    const [discounts, invoices, quota] = await Promise.all([
      this.getDiscounts(tenantId),
      this.getInvoices(tenantId),
      XPayService.getQuotaStatus(tenantId),
    ]);
    return {
      selfServeThresholdPkr: SELF_SERVE_THRESHOLD_PKR,
      discounts,
      invoices,
      currentBonusTokens: quota.bonusTokens,
      totalTokenLimit: quota.totalLimit,
    };
  }

  /**
   * Creates a new discount rule (`percentage`, `volume`, `loyalty`, `group_code`, or `trial_credit`).
   * If type === 'trial_credit', immediately credits the free trial tokens to the tenant's balance.
   */
  static async createDiscountRule(
    tenantId: string,
    input: {
      code: string;
      type: DiscountType;
      percentageOff?: number;
      flatAmountOffPkr?: number;
      bonusTrialTokens?: number;
      minOrderPkr?: number;
      validDays?: number;
      appliedBy?: string;
      notes?: string;
    }
  ): Promise<DiscountRule> {
    const discounts = await this.getDiscounts(tenantId);
    const now = new Date();
    const validDays = Math.max(1, Number(input.validDays || 90));
    const until = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);

    const rule: DiscountRule = {
      id: `dsc_${randomUUID().slice(0, 8)}`,
      code: input.code.trim().toUpperCase(),
      type: input.type || 'percentage',
      percentageOff: Math.min(100, Math.max(0, Number(input.percentageOff || 0))),
      flatAmountOffPkr: Math.max(0, Number(input.flatAmountOffPkr || 0)),
      bonusTrialTokens: Math.max(0, Number(input.bonusTrialTokens || 0)),
      minOrderPkr: Math.max(0, Number(input.minOrderPkr || 0)),
      validFrom: now.toISOString(),
      validUntil: until.toISOString(),
      appliedBy: input.appliedBy || 'Sidat Super User',
      notes: input.notes || `${input.type} discount applied`,
      active: true,
    };

    discounts.unshift(rule);
    await this.saveDiscounts(tenantId, discounts);

    if (rule.type === 'trial_credit' && rule.bonusTrialTokens > 0) {
      const quotaCfg = await XPayService.loadTenantQuotaConfig(tenantId);
      quotaCfg.bonusTokens += rule.bonusTrialTokens;
      await XPayService.saveTenantQuotaConfig(tenantId, quotaCfg);
    }

    return rule;
  }

  /**
   * Evaluates applicable discount for an order amount and optional promo code.
   */
  static async evaluateDiscount(
    tenantId: string,
    grossAmountPkr: number,
    discountCode?: string
  ): Promise<{
    grossAmountPkr: number;
    discountAppliedPkr: number;
    netAmountPkr: number;
    matchedRule?: DiscountRule;
  }> {
    const discounts = await this.getDiscounts(tenantId);
    const now = Date.now();

    let matchedRule: DiscountRule | undefined;
    if (discountCode) {
      const normalized = discountCode.trim().toUpperCase();
      matchedRule = discounts.find(
        (d) =>
          d.active &&
          d.code === normalized &&
          grossAmountPkr >= d.minOrderPkr &&
          new Date(d.validUntil).getTime() >= now
      );
    }

    // Automatic volume discount fallback if no promo code matched and order >= 100,000 PKR
    if (!matchedRule && grossAmountPkr >= SELF_SERVE_THRESHOLD_PKR) {
      matchedRule = discounts.find(
        (d) =>
          d.active &&
          d.type === 'volume' &&
          grossAmountPkr >= d.minOrderPkr &&
          new Date(d.validUntil).getTime() >= now
      );
    }

    let discountAppliedPkr = 0;
    if (matchedRule) {
      if (matchedRule.percentageOff > 0) {
        discountAppliedPkr = Math.round((grossAmountPkr * matchedRule.percentageOff) / 100);
      } else if (matchedRule.flatAmountOffPkr > 0) {
        discountAppliedPkr = Math.min(grossAmountPkr, matchedRule.flatAmountOffPkr);
      }
    }

    const netAmountPkr = Math.max(0, grossAmountPkr - discountAppliedPkr);
    return {
      grossAmountPkr,
      discountAppliedPkr,
      netAmountPkr,
      matchedRule,
    };
  }

  /**
   * Submits a formal Enterprise Invoice Request (for purchases >= PKR 100,000 or custom allocations)
   * per Blueprint Section 6.3.
   */
  static async submitEnterpriseInvoiceRequest(
    tenantId: string,
    input: {
      requestedTokens: number;
      grossAmountPkr: number;
      discountCode?: string;
      requestedBy?: string;
      notes?: string;
    }
  ): Promise<EnterpriseInvoiceRecord> {
    const evalResult = await this.evaluateDiscount(
      tenantId,
      Number(input.grossAmountPkr),
      input.discountCode
    );

    const invoices = await this.getInvoices(tenantId);
    const inv: EnterpriseInvoiceRecord = {
      id: `inv_${randomUUID().slice(0, 8)}`,
      invoiceNumber: `V3C-INV-${new Date().getFullYear()}-${String(invoices.length + 101)}`,
      tenantId,
      requestedTokens: Number(input.requestedTokens),
      grossAmountPkr: evalResult.grossAmountPkr,
      discountAppliedPkr: evalResult.discountAppliedPkr,
      netAmountPkr: evalResult.netAmountPkr,
      discountCode: evalResult.matchedRule?.code || input.discountCode?.toUpperCase(),
      status: 'invoiced',
      requestedBy: input.requestedBy || 'Company Admin',
      notes: input.notes || 'Enterprise large-order invoice request (> PKR 100,000 threshold)',
      createdAt: new Date().toISOString(),
    };

    invoices.unshift(inv);
    await this.saveInvoices(tenantId, invoices);

    await prisma.notification
      .create({
        data: {
          id: randomUUID(),
          tenantId,
          type: 'INFO',
          title: `Enterprise Invoice Generated: ${inv.invoiceNumber}`,
          message: `Invoice ${inv.invoiceNumber} for ${inv.requestedTokens.toLocaleString()} tokens (Net PKR ${inv.netAmountPkr.toLocaleString()}) awaits bank payment confirmation.`,
        },
      })
      .catch(() => undefined);

    return inv;
  }

  /**
   * Sidat Super User manual credit upon invoice payment confirmation (Blueprint Sec 6.3).
   */
  static async approveAndCreditInvoice(
    tenantId: string,
    invoiceId: string,
    input: { approvedBy?: string; reason?: string }
  ) {
    const invoices = await this.getInvoices(tenantId);
    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }
    if (invoice.status === 'paid_credited') {
      return { invoice, alreadyCredited: true };
    }

    invoice.status = 'paid_credited';
    invoice.approvedBy = input.approvedBy || 'Sidat Super User';
    invoice.approvalReason =
      input.reason || 'Bank transfer verified against commercial invoice';
    invoice.creditedAt = new Date().toISOString();
    await this.saveInvoices(tenantId, invoices);

    // Credit tokens to tenant's quota balance
    const quotaCfg = await XPayService.loadTenantQuotaConfig(tenantId);
    quotaCfg.bonusTokens += invoice.requestedTokens;
    await XPayService.saveTenantQuotaConfig(tenantId, quotaCfg);

    const updatedQuota = await XPayService.getQuotaStatus(tenantId);

    await prisma.notification
      .create({
        data: {
          id: randomUUID(),
          tenantId,
          type: 'SUCCESS',
          title: `Tokens Credited for Invoice ${invoice.invoiceNumber}`,
          message: `Sidat Super User credited ${invoice.requestedTokens.toLocaleString()} tokens (${invoice.approvalReason}). New limit: ${updatedQuota.totalLimit.toLocaleString()} tokens.`,
        },
      })
      .catch(() => undefined);

    return {
      invoice,
      alreadyCredited: false,
      updatedQuota,
    };
  }
}
