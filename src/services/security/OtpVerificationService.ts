import { randomInt, randomUUID } from 'crypto';
import prisma from '../../lib/prisma';

export type OtpPurpose =
  | 'password_change'
  | 'profile_sensitive_change'
  | 'conversation_account_action';

export interface OtpPolicyConfig {
  otpLength: 4 | 6;
  expirySeconds: number;
  maxAttempts: number;
  deliveryMethod: 'sms_and_email' | 'sms_only' | 'email_only';
  enforceOnAdminPasswordChange: boolean;
  enforceOnConversationAccountModify: boolean;
}

export interface OtpChallengeRecord {
  challengeId: string;
  tenantId: string;
  subjectId: string;
  purpose: OtpPurpose;
  code: string;
  targetContact: string;
  attemptsUsed: number;
  maxAttempts: number;
  lockedOut: boolean;
  verified: boolean;
  verifiedUntil?: number;
  expiresAt: number;
  createdAt: string;
}

const OTP_CONFIG_KEY = 'v3c_otp_auth_config_v1';

// In-memory store for active OTP challenges & verified sessions
const activeChallenges = new Map<string, OtpChallengeRecord>();

const SENSITIVE_ACTION_REGEX = new RegExp(
  '\\b(change\\s+(my\\s+)?(phone|number|email|password|address|iban|bank|beneficiary|plan|nominee)|' +
    'update\\s+(my\\s+)?(phone|number|email|password|address|iban|bank|beneficiary|account|policy)|' +
    'modify\\s+(my\\s+)?(account|policy|profile|subscription|details)|' +
    'cancel\\s+(my\\s+)?(policy|subscription|account|plan)|' +
    'delete\\s+(my\\s+)?(account|profile)|' +
    'mera\\s+(number|phone|email|address|account|policy)\\s+(change|tabdeel|update|cancel|band)|' +
    '(number|phone|email|policy|account)\\s+(change|tabdeel|update|cancel)\\s+(karo|karna|karen|krna))\\b|' +
    '(نمبر تبدیل|پالیسی کینسل|اکاؤنٹ اپڈیٹ|ایڈریس تبدیل)',
  'i'
);

export class OtpVerificationService {
  private static getKey(tenantId: string, subjectId: string, purpose: OtpPurpose): string {
    return `${tenantId}:${subjectId}:${purpose}`;
  }

  static getDefaultPolicy(): OtpPolicyConfig {
    return {
      otpLength: 6,
      expirySeconds: 300,
      maxAttempts: 3,
      deliveryMethod: 'sms_and_email',
      enforceOnAdminPasswordChange: true,
      enforceOnConversationAccountModify: true,
    };
  }

  static async getPolicy(tenantId: string): Promise<OtpPolicyConfig> {
    const config = await prisma.configuration.findFirst({
      where: { tenantId, key: OTP_CONFIG_KEY },
    });
    if (!config) {
      const defaults = this.getDefaultPolicy();
      await this.savePolicy(tenantId, defaults);
      return defaults;
    }
    try {
      const parsed = JSON.parse(config.value || '{}');
      return {
        ...this.getDefaultPolicy(),
        ...parsed,
      };
    } catch {
      return this.getDefaultPolicy();
    }
  }

  static async savePolicy(
    tenantId: string,
    update: Partial<OtpPolicyConfig>
  ): Promise<OtpPolicyConfig> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: OTP_CONFIG_KEY },
    });
    let current = this.getDefaultPolicy();
    if (existing?.value) {
      try {
        current = { ...current, ...JSON.parse(existing.value) };
      } catch {}
    }

    const merged: OtpPolicyConfig = {
      otpLength: update.otpLength === 4 ? 4 : 6,
      expirySeconds: Math.min(900, Math.max(60, Number(update.expirySeconds ?? current.expirySeconds))),
      maxAttempts: Math.min(5, Math.max(1, Number(update.maxAttempts ?? current.maxAttempts))),
      deliveryMethod: update.deliveryMethod || current.deliveryMethod,
      enforceOnAdminPasswordChange:
        update.enforceOnAdminPasswordChange !== undefined
          ? Boolean(update.enforceOnAdminPasswordChange)
          : current.enforceOnAdminPasswordChange,
      enforceOnConversationAccountModify:
        update.enforceOnConversationAccountModify !== undefined
          ? Boolean(update.enforceOnConversationAccountModify)
          : current.enforceOnConversationAccountModify,
    };

    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: JSON.stringify(merged), updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: OTP_CONFIG_KEY,
          value: JSON.stringify(merged),
          updatedAt: new Date(),
        },
      });
    }
    return merged;
  }

  /**
   * Detects whether a message requests a sensitive account or policy modification
   * per Blueprint Section 4.2 & 4.6 (Modification restriction guardrail).
   */
  static detectSensitiveAccountAction(message: string): boolean {
    if (!message) return false;
    return SENSITIVE_ACTION_REGEX.test(message.trim());
  }

  /**
   * Checks whether a given subject + purpose has an active, unverified OTP challenge waiting for a code.
   */
  static hasPendingChallenge(tenantId: string, subjectId: string, purpose: OtpPurpose): boolean {
    const record = activeChallenges.get(this.getKey(tenantId, subjectId, purpose));
    if (!record) return false;
    if (record.verified || record.lockedOut) return false;
    if (Date.now() > record.expiresAt) return false;
    return true;
  }

  /**
   * Checks whether a subject + purpose has already completed OTP verification within the active window (15 mins).
   */
  static isVerified(tenantId: string, subjectId: string, purpose: OtpPurpose): boolean {
    const record = activeChallenges.get(this.getKey(tenantId, subjectId, purpose));
    if (!record || !record.verified) return false;
    if (record.verifiedUntil && Date.now() > record.verifiedUntil) {
      return false;
    }
    return true;
  }

  /**
   * Consumes a verified grant after a one-time sensitive action (like password change) is completed.
   */
  static consumeVerification(tenantId: string, subjectId: string, purpose: OtpPurpose): void {
    activeChallenges.delete(this.getKey(tenantId, subjectId, purpose));
  }

  /**
   * Issues a new OTP challenge for the given tenant + subject + purpose.
   */
  static async issueOtp(params: {
    tenantId: string;
    subjectId: string;
    purpose: OtpPurpose;
    targetContact?: string;
  }) {
    const policy = await this.getPolicy(params.tenantId);
    const min = policy.otpLength === 4 ? 1000 : 100000;
    const max = policy.otpLength === 4 ? 9999 : 999999;
    const code = String(randomInt(min, max + 1));
    const now = Date.now();

    const record: OtpChallengeRecord = {
      challengeId: `otp_${randomUUID().slice(0, 10)}`,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      purpose: params.purpose,
      code,
      targetContact: params.targetContact || 'registered-contact',
      attemptsUsed: 0,
      maxAttempts: policy.maxAttempts,
      lockedOut: false,
      verified: false,
      expiresAt: now + policy.expirySeconds * 1000,
      createdAt: new Date(now).toISOString(),
    };

    activeChallenges.set(
      this.getKey(params.tenantId, params.subjectId, params.purpose),
      record
    );

    // Log notification for audit trail
    await prisma.notification
      .create({
        data: {
          id: randomUUID(),
          tenantId: params.tenantId,
          type: 'INFO',
          title: `OTP Issued (${params.purpose})`,
          message: `A ${policy.otpLength}-digit OTP was issued to ${record.targetContact} for ${params.purpose} (expires in ${policy.expirySeconds}s).`,
        },
      })
      .catch(() => undefined);

    return {
      challengeId: record.challengeId,
      purpose: record.purpose,
      otpLength: policy.otpLength,
      expirySeconds: policy.expirySeconds,
      maxAttempts: policy.maxAttempts,
      deliveryMethod: policy.deliveryMethod,
      targetContact: record.targetContact,
      // Sandbox preview included so admins/testers can immediately copy-paste the code during testing
      sandboxOtpPreview: code,
    };
  }

  /**
   * Verifies a submitted OTP code against the active challenge.
   * Enforces expiry and max-attempts lockout.
   */
  static async verifyOtp(params: {
    tenantId: string;
    subjectId: string;
    purpose: OtpPurpose;
    code: string;
  }): Promise<{
    verified: boolean;
    lockedOut: boolean;
    remainingAttempts: number;
    reason: string;
  }> {
    const key = this.getKey(params.tenantId, params.subjectId, params.purpose);
    const record = activeChallenges.get(key);

    if (!record) {
      return {
        verified: false,
        lockedOut: false,
        remainingAttempts: 0,
        reason: 'No active OTP challenge found. Please request a new OTP.',
      };
    }

    if (record.lockedOut) {
      return {
        verified: false,
        lockedOut: true,
        remainingAttempts: 0,
        reason: `Account action locked after ${record.maxAttempts} failed OTP attempts. Please request a new OTP or contact support.`,
      };
    }

    if (Date.now() > record.expiresAt) {
      return {
        verified: false,
        lockedOut: false,
        remainingAttempts: 0,
        reason: 'OTP has expired. Please request a new OTP code.',
      };
    }

    const cleanInput = String(params.code || '').trim();
    if (cleanInput !== record.code) {
      record.attemptsUsed += 1;
      const remaining = Math.max(0, record.maxAttempts - record.attemptsUsed);
      if (remaining === 0) {
        record.lockedOut = true;
      }
      activeChallenges.set(key, record);

      return {
        verified: false,
        lockedOut: record.lockedOut,
        remainingAttempts: remaining,
        reason: record.lockedOut
          ? `Maximum OTP attempts (${record.maxAttempts}) exceeded. Action locked.`
          : `Invalid OTP code. ${remaining} attempt(s) remaining.`,
      };
    }

    // Success! Mark verified for 15 minutes
    record.verified = true;
    record.verifiedUntil = Date.now() + 15 * 60 * 1000;
    activeChallenges.set(key, record);

    await prisma.notification
      .create({
        data: {
          id: randomUUID(),
          tenantId: params.tenantId,
          type: 'SUCCESS',
          title: `OTP Verified (${params.purpose})`,
          message: `OTP verification succeeded for subject ${params.subjectId} (${params.purpose}).`,
        },
      })
      .catch(() => undefined);

    return {
      verified: true,
      lockedOut: false,
      remainingAttempts: record.maxAttempts - record.attemptsUsed,
      reason: 'OTP verified successfully. Sensitive account action is now authorized.',
    };
  }
}
