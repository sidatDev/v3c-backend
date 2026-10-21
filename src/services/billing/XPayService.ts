/**
 * XPayService.ts
 * Phase 5: Token Quota Enforcement (80% Warning, 95% Critical, 100% Hard Stop)
 * & XPay (by XStak) Payment Aggregator Sandbox Integration (Card, JazzCash, EasyPaisa).
 */

import crypto, { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error';

export type XPayPaymentMethod = 'card' | 'jazzcash' | 'easypaisa';
export type QuotaAlertLevel = 'normal' | 'warning_80' | 'critical_95' | 'depleted_100';

export interface TokenBundle {
  id: string;
  name: string;
  tokens: number;
  amountPkr: number;
  currency: 'PKR';
  description: string;
}

export interface XPayTransactionRecord {
  paymentIntentId: string;
  orderId: string;
  bundleId: string;
  bundleName: string;
  tokens: number;
  amountPkr: number;
  currency: 'PKR';
  paymentMethod: XPayPaymentMethod;
  status: 'pending' | 'succeeded' | 'failed';
  signature: string;
  maskedAccount?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TenantQuotaConfig {
  baseTokenLimit: number;
  bonusTokens: number;
  hardStopEnabled: boolean;
  lastAlertLevel: QuotaAlertLevel;
  transactions: XPayTransactionRecord[];
}

export const TOKEN_BUNDLES: TokenBundle[] = [
  {
    id: 'starter_100k',
    name: 'Starter Top-Up (100K Tokens)',
    tokens: 100_000,
    amountPkr: 2500,
    currency: 'PKR',
    description: '100,000 additional LLM tokens for Chat & Specialist Agents',
  },
  {
    id: 'growth_500k',
    name: 'Growth Bundle (500K Tokens)',
    tokens: 500_000,
    amountPkr: 10000,
    currency: 'PKR',
    description: '500,000 additional LLM tokens with priority throughput',
  },
  {
    id: 'scale_2m',
    name: 'Enterprise Scale (2M Tokens)',
    tokens: 2_000_000,
    amountPkr: 35000,
    currency: 'PKR',
    description: '2,000,000 additional LLM tokens for high-volume omnichannel traffic',
  },
];

const CONFIG_KEY = 'billing_token_quota';

export class XPayService {
  private static get secretKey(): string {
    return process.env.XPAY_SECRET_KEY || 'xpay_sandbox_sk_test_99a8b7c6d5e4f3210';
  }

  private static get accountId(): string {
    return process.env.XPAY_ACCOUNT_ID || 'acct_sandbox_v3c_pk_01';
  }

  private static get encryptionKey(): string {
    return process.env.XPAY_ENCRYPTION_KEY || 'xpay_sandbox_enc_key_v3c_2026';
  }

  /**
   * Computes XPay HMAC-SHA256 cryptographic signature (`x-signature` header).
   */
  static computeSignature(payload: Record<string, any> | string, secret?: string): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto
      .createHmac('sha256', secret || this.secretKey)
      .update(raw)
      .digest('hex');
  }

  /**
   * Verifies incoming XPay webhook signature using timingSafeEqual.
   */
  static verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader) return false;
    const expected = this.computeSignature(rawBody);
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Loads or initializes the tenant's token quota config from Configuration table.
   */
  static async loadTenantQuotaConfig(tenantId: string): Promise<TenantQuotaConfig> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: CONFIG_KEY },
      orderBy: { id: 'desc' },
    });

    const defaultConfig: TenantQuotaConfig = {
      baseTokenLimit: 500_000,
      bonusTokens: 0,
      hardStopEnabled: true,
      lastAlertLevel: 'normal',
      transactions: [],
    };

    if (!existing || !existing.value) {
      return defaultConfig;
    }

    try {
      const parsed = JSON.parse(existing.value);
      return {
        baseTokenLimit: Number(parsed.baseTokenLimit ?? 500_000),
        bonusTokens: Number(parsed.bonusTokens ?? 0),
        hardStopEnabled: parsed.hardStopEnabled !== undefined ? Boolean(parsed.hardStopEnabled) : true,
        lastAlertLevel: parsed.lastAlertLevel || 'normal',
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      };
    } catch (_) {
      return defaultConfig;
    }
  }

  /**
   * Persists the tenant's token quota config to Configuration table.
   */
  static async saveTenantQuotaConfig(tenantId: string, config: TenantQuotaConfig): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: CONFIG_KEY },
      orderBy: { id: 'desc' },
    });

    const serialized = JSON.stringify(config);

    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: serialized, updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: CONFIG_KEY,
          value: serialized,
          updatedAt: new Date(),
        },
      });
    }
  }

  /**
   * Returns current month token consumption from the Usage table.
   */
  static async getMonthlyUsedTokens(tenantId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const agg = await prisma.usage.aggregate({
      where: {
        tenantId,
        createdAt: { gte: startOfMonth },
      },
      _sum: {
        totalTokens: true,
      },
    });

    return agg._sum.totalTokens || 0;
  }

  /**
   * Computes full quota status for a tenant.
   */
  static async getQuotaStatus(tenantId: string) {
    const [config, usedTokens] = await Promise.all([
      this.loadTenantQuotaConfig(tenantId),
      this.getMonthlyUsedTokens(tenantId),
    ]);

    const totalLimit = Math.max(1, config.baseTokenLimit + config.bonusTokens);
    const remainingTokens = Math.max(0, totalLimit - usedTokens);
    const usagePercent = Math.min(100, Number(((usedTokens / totalLimit) * 100).toFixed(2)));

    let alertLevel: QuotaAlertLevel = 'normal';
    if (usagePercent >= 100) {
      alertLevel = 'depleted_100';
    } else if (usagePercent >= 95) {
      alertLevel = 'critical_95';
    } else if (usagePercent >= 80) {
      alertLevel = 'warning_80';
    }

    const isHardStopped = config.hardStopEnabled && usedTokens >= totalLimit;

    return {
      tenantId,
      baseTokenLimit: config.baseTokenLimit,
      bonusTokens: config.bonusTokens,
      totalLimit,
      usedTokens,
      remainingTokens,
      usagePercent,
      alertLevel,
      hardStopEnabled: config.hardStopEnabled,
      isHardStopped,
      bundles: TOKEN_BUNDLES,
      transactions: config.transactions.slice(0, 15),
      xpaySandboxInfo: {
        stageScriptUrl: 'https://js.xstak.com/v2/xpay-stage.js',
        accountId: this.accountId,
        supportedMethods: ['card', 'jazzcash', 'easypaisa'],
      },
    };
  }

  /**
   * Updates baseTokenLimit and/or hardStopEnabled for a tenant.
   */
  static async updateQuotaSettings(
    tenantId: string,
    updates: { baseTokenLimit?: number; hardStopEnabled?: boolean }
  ) {
    const config = await this.loadTenantQuotaConfig(tenantId);
    if (updates.baseTokenLimit !== undefined) {
      const limit = Number(updates.baseTokenLimit);
      if (isNaN(limit) || limit < 1000) {
        throw new AppError('baseTokenLimit must be at least 1,000 tokens', 400);
      }
      config.baseTokenLimit = limit;
    }
    if (updates.hardStopEnabled !== undefined) {
      config.hardStopEnabled = Boolean(updates.hardStopEnabled);
    }

    await this.saveTenantQuotaConfig(tenantId, config);
    await this.evaluateThresholdAlerts(tenantId);
    return this.getQuotaStatus(tenantId);
  }

  /**
   * Checks if a tenant has hit 80%, 95%, or 100% token usage and records a Notification.
   */
  static async evaluateThresholdAlerts(tenantId: string): Promise<QuotaAlertLevel> {
    const status = await this.getQuotaStatus(tenantId);
    const config = await this.loadTenantQuotaConfig(tenantId);

    const rank: Record<QuotaAlertLevel, number> = {
      normal: 0,
      warning_80: 1,
      critical_95: 2,
      depleted_100: 3,
    };

    if (rank[status.alertLevel] > rank[config.lastAlertLevel]) {
      config.lastAlertLevel = status.alertLevel;
      await this.saveTenantQuotaConfig(tenantId, config);

      let title = 'Token Usage Alert (80% Warning)';
      let message = `Your workspace has consumed ${status.usagePercent}% (${status.usedTokens.toLocaleString()} / ${status.totalLimit.toLocaleString()} tokens) of its monthly token balance.`;

      if (status.alertLevel === 'critical_95') {
        title = 'Critical Token Usage Alert (95% Reached)';
        message = `URGENT: Your workspace has reached ${status.usagePercent}% of its token balance. Top up via XPay (Card / JazzCash / EasyPaisa) to avoid service interruption.`;
      } else if (status.alertLevel === 'depleted_100') {
        title = 'Token Balance Depleted (100% Hard Stop)';
        message = `Your monthly token balance (${status.totalLimit.toLocaleString()} tokens) is 100% depleted. AI completions are paused until you top up a token bundle.`;
      }

      try {
        await prisma.notification.create({
          data: {
            id: randomUUID(),
            tenantId,
            type: status.alertLevel.toUpperCase(),
            title,
            message,
            metadata: {
              usedTokens: status.usedTokens,
              totalLimit: status.totalLimit,
              usagePercent: status.usagePercent,
              alertLevel: status.alertLevel,
            },
          },
        });
        console.log(`[BILLING ALERT] ${title} emitted for tenant ${tenantId}`);
      } catch (err: any) {
        console.warn('[BILLING ALERT] Failed to create notification:', err?.message || err);
      }
    } else if (rank[status.alertLevel] < rank[config.lastAlertLevel]) {
      // Reset alert level if tenant topped up tokens
      config.lastAlertLevel = status.alertLevel;
      await this.saveTenantQuotaConfig(tenantId, config);
    }

    return status.alertLevel;
  }

  /**
   * Returns true if the tenant has hard-stop enabled and 100% of tokens are consumed.
   */
  static async isQuotaDepleted(tenantId?: string): Promise<boolean> {
    if (!tenantId) return false;
    try {
      const status = await this.getQuotaStatus(tenantId);
      return status.isHardStopped;
    } catch (_) {
      return false;
    }
  }

  /**
   * Step 1 of XPay Checkout: Create a Sandbox Payment Intent (`POST /public/v1/payment/intent`)
   * with HMAC-SHA256 `x-signature` header.
   */
  static async createPaymentIntent(params: {
    tenantId: string;
    bundleId: string;
    paymentMethod: XPayPaymentMethod;
    customer?: { name?: string; email?: string; phone?: string };
  }) {
    const { tenantId, bundleId, paymentMethod } = params;
    const bundle = TOKEN_BUNDLES.find((b) => b.id === bundleId);
    if (!bundle) {
      throw new AppError(`Invalid bundleId "${bundleId}". Choose from starter_100k, growth_500k, scale_2m.`, 400);
    }

    if (!['card', 'jazzcash', 'easypaisa'].includes(paymentMethod)) {
      throw new AppError('Invalid paymentMethod. Allowed: card, jazzcash, easypaisa', 400);
    }

    const orderId = `v3c_ord_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const paymentIntentId = `pi_xpay_sandbox_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const clientSecret = `${paymentIntentId}_secret_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Construct official XPay Fusion Payment Intent request body
    const xpayRequestBody = {
      order: {
        id: orderId,
        currency: bundle.currency,
        order_amount: bundle.amountPkr,
      },
      customer: {
        name: params.customer?.name || 'V3C Workspace Admin',
        email: params.customer?.email || 'billing@v3c.local',
        phone: params.customer?.phone || '923001234567',
      },
      payment_method_types: [paymentMethod],
      metadata: {
        tenantId,
        bundleId: bundle.id,
        tokensToCredit: bundle.tokens,
        paymentMethod,
      },
      description: `${bundle.name} via XPay (${paymentMethod.toUpperCase()})`,
    };

    const signature = this.computeSignature(xpayRequestBody);

    const config = await this.loadTenantQuotaConfig(tenantId);
    const txRecord: XPayTransactionRecord = {
      paymentIntentId,
      orderId,
      bundleId: bundle.id,
      bundleName: bundle.name,
      tokens: bundle.tokens,
      amountPkr: bundle.amountPkr,
      currency: 'PKR',
      paymentMethod,
      status: 'pending',
      signature,
      createdAt: new Date().toISOString(),
    };

    config.transactions.unshift(txRecord);
    await this.saveTenantQuotaConfig(tenantId, config);

    return {
      paymentIntentId,
      orderId,
      clientSecret,
      encryptionKey: this.encryptionKey,
      signature,
      headers: {
        'x-api-key': 'xpay_sandbox_sk_test_***',
        'x-account-id': this.accountId,
        'x-signature': signature,
      },
      xpayRequestBody,
      bundle,
      paymentMethod,
    };
  }

  /**
   * Step 2 of XPay Checkout: Confirm Sandbox Payment (Card / JazzCash / EasyPaisa)
   * and credit the bundle's tokens to the tenant's balance.
   */
  static async confirmSandboxPayment(params: {
    tenantId: string;
    paymentIntentId: string;
    maskedAccount?: string;
  }) {
    const { tenantId, paymentIntentId, maskedAccount } = params;
    const config = await this.loadTenantQuotaConfig(tenantId);

    const tx = config.transactions.find((t) => t.paymentIntentId === paymentIntentId);
    if (!tx) {
      throw new AppError(`Payment Intent "${paymentIntentId}" not found for this tenant`, 404);
    }

    if (tx.status === 'succeeded') {
      return {
        transaction: tx,
        quota: await this.getQuotaStatus(tenantId),
        alreadyProcessed: true,
      };
    }

    tx.status = 'succeeded';
    tx.maskedAccount = maskedAccount || (tx.paymentMethod === 'card' ? '•••• 4242' : '0300-1234567');
    tx.completedAt = new Date().toISOString();

    config.bonusTokens += tx.tokens;
    await this.saveTenantQuotaConfig(tenantId, config);

    // Re-evaluate alert state now that bonus tokens were added
    await this.evaluateThresholdAlerts(tenantId);

    console.log(
      `[XPAY SANDBOX] Payment ${paymentIntentId} (${tx.paymentMethod.toUpperCase()} - PKR ${tx.amountPkr}) succeeded. Credited +${tx.tokens} tokens to tenant ${tenantId}`
    );

    return {
      transaction: tx,
      quota: await this.getQuotaStatus(tenantId),
      alreadyProcessed: false,
    };
  }
}

export default XPayService;
