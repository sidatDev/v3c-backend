import { TenantConfig } from '../cache/TenantConfigCache';
import { StructuredLogger } from '../logger/StructuredLogger';

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|directives|prompts)\b/i,
  /\breveal\s+(the\s+)?(system|developer|hidden|initial)\s+(prompt|instructions|rules)\b/i,
  /\bwhat\s+(is|are)\s+your\s+(exact\s+)?(system\s+prompt|initial\s+instructions)\b/i,
  /\b(you\s+are\s+now|act\s+as)\s+(a\s+)?(jailbreak|dan|unfiltered|developer|root|admin)\b/i,
  /\b(override|bypass|forget)\s+(all\s+)?(your\s+)?(rules|safety|instructions|guardrails)\b/i,
  /\bshow\s+me\s+your\s+(system|source)\s+(prompt|code)\b/i,
];

export class SecurityShieldService {
  /**
   * Scan text for prompt injection / jailbreak patterns
   */
  static detectPromptInjection(text: string): string | null {
    if (!text || text.trim().length === 0) return null;
    const trimmed = text.trim();

    for (const pattern of INJECTION_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        StructuredLogger.warn('[SecurityShield] Prompt injection pattern detected', {
          match: match[0],
          sampleText: trimmed.substring(0, 100)
        });
        return match[0];
      }
    }
    return null;
  }

  /**
   * Verify HTTP Origin / Referer against Tenant allowed domains
   */
  static verifyDomainOrigin(
    originHeader?: string,
    refererHeader?: string,
    tenantConfig?: TenantConfig
  ): { allowed: boolean; reason?: string } {
    const isDev = process.env.NODE_ENV !== 'production';
    const rawHost = originHeader || refererHeader || '';

    if (!rawHost) {
      if (isDev) return { allowed: true };
    }

    const hostLower = rawHost.toLowerCase();
    if (isDev && (hostLower.includes('localhost') || hostLower.includes('127.0.0.1') || hostLower.includes('file://'))) {
      return { allowed: true };
    }

    if (!tenantConfig) return { allowed: true };

    const allowedDomains: string[] = [];
    if (tenantConfig.domain?.domainName) {
      allowedDomains.push(tenantConfig.domain.domainName.toLowerCase());
    }

    const widgetMeta = tenantConfig.widgetConfig as any;
    if (widgetMeta && Array.isArray(widgetMeta.allowedDomains)) {
      for (const d of widgetMeta.allowedDomains) {
        if (typeof d === 'string' && d.trim()) {
          allowedDomains.push(d.trim().toLowerCase());
        }
      }
    }

    if (allowedDomains.length === 0) {
      return { allowed: true };
    }

    let hostname = hostLower;
    try {
      if (hostLower.startsWith('http://') || hostLower.startsWith('https://')) {
        hostname = new URL(hostLower).hostname;
      }
    } catch (_) {}

    const isMatch = allowedDomains.some(domain => {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return hostname === cleanDomain || hostname.endsWith(`.${cleanDomain}`);
    });

    if (!isMatch) {
      StructuredLogger.warn('[SecurityShield] Domain origin verification failed', {
        hostname,
        allowedDomains,
        tenantId: tenantConfig.tenantId
      });
      return {
        allowed: false,
        reason: `Domain origin '${hostname}' is not authorized for this widget session.`
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a visitor session has exceeded maximum turn limit
   */
  static checkSessionTurnCap(currentTurnCount: number, maxTurns: number = 25): { exceeded: boolean; remaining: number } {
    const exceeded = currentTurnCount > maxTurns;
    const remaining = Math.max(0, maxTurns - currentTurnCount);

    if (exceeded) {
      StructuredLogger.info('[SecurityShield] Session turn cap exceeded', {
        currentTurnCount,
        maxTurns
      });
    }

    return { exceeded, remaining };
  }
}
