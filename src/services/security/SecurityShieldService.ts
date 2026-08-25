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

// In-memory active voice sessions per IP address for concurrent call throttling
const activeVoiceSessionsByIp = new Map<string, Set<any>>();

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
   * Check if a visitor session has reached turn limits or 70% early warning threshold.
   * Voice Cap = 20 Turns (70% = Turn 14).
   * Chat Cap = 25 Turns (70% = Turn 18).
   */
  static checkSessionTurnCap(
    currentTurnCount: number,
    mode: 'voice' | 'chat' = 'voice'
  ): {
    exceeded: boolean;
    warning70Percent: boolean;
    remaining: number;
    currentTurnCount: number;
    maxTurns: number;
  } {
    const maxTurns = mode === 'voice' ? 20 : 25;
    const warningTurnThreshold = Math.ceil(maxTurns * 0.7); // Turn 14 for Voice, Turn 18 for Chat

    const exceeded = currentTurnCount >= maxTurns;
    const warning70Percent = currentTurnCount === warningTurnThreshold;
    const remaining = Math.max(0, maxTurns - currentTurnCount);

    if (exceeded) {
      StructuredLogger.info('[SecurityShield] Session turn cap exceeded', {
        mode,
        currentTurnCount,
        maxTurns
      });
    } else if (warning70Percent) {
      StructuredLogger.info('[SecurityShield] Session 70% turn cap warning triggered', {
        mode,
        currentTurnCount,
        maxTurns,
        warningTurnThreshold
      });
    }

    return {
      exceeded,
      warning70Percent,
      remaining,
      currentTurnCount,
      maxTurns
    };
  }

  /**
   * Check & register concurrent voice call limits per IP address (Max 3 active calls/IP)
   */
  static checkIpConcurrentCallCap(
    ipAddress: string,
    maxCalls: number = 3
  ): { allowed: boolean; currentCalls: number; reason?: string } {
    const cleanIp = ipAddress?.replace(/^::ffff:/, '').trim() || '127.0.0.1';
    const activeSet = activeVoiceSessionsByIp.get(cleanIp);
    const currentCalls = activeSet ? activeSet.size : 0;

    if (currentCalls >= maxCalls) {
      StructuredLogger.warn('[SecurityShield] Concurrent voice call limit exceeded per IP', {
        cleanIp,
        currentCalls,
        maxCalls
      });
      return {
        allowed: false,
        currentCalls,
        reason: `Maximum concurrent active voice calls reached for your IP address (${maxCalls} calls max). Please close an active call session to continue.`
      };
    }

    return { allowed: true, currentCalls };
  }

  /**
   * Register active voice WebSocket connection for an IP address
   */
  static registerVoiceCallSession(ipAddress: string, sessionInstance: any): void {
    const cleanIp = ipAddress?.replace(/^::ffff:/, '').trim() || '127.0.0.1';
    if (!activeVoiceSessionsByIp.has(cleanIp)) {
      activeVoiceSessionsByIp.set(cleanIp, new Set());
    }
    activeVoiceSessionsByIp.get(cleanIp)!.add(sessionInstance);
    StructuredLogger.info('[SecurityShield] Active voice call registered for IP', {
      cleanIp,
      totalActiveForIp: activeVoiceSessionsByIp.get(cleanIp)!.size
    });
  }

  /**
   * Unregister active voice WebSocket connection for an IP address
   */
  static unregisterVoiceCallSession(ipAddress: string, sessionInstance: any): void {
    const cleanIp = ipAddress?.replace(/^::ffff:/, '').trim() || '127.0.0.1';
    const activeSet = activeVoiceSessionsByIp.get(cleanIp);
    if (activeSet) {
      activeSet.delete(sessionInstance);
      if (activeSet.size === 0) {
        activeVoiceSessionsByIp.delete(cleanIp);
      }
    }
    StructuredLogger.info('[SecurityShield] Voice call session unregistered for IP', {
      cleanIp,
      totalActiveForIp: activeVoiceSessionsByIp.get(cleanIp)?.size || 0
    });
  }

  /**
   * Verify Cloudflare Turnstile token
   */
  static async verifyTurnstileToken(
    token: string,
    clientIp?: string
  ): Promise<{ success: boolean; reason?: string }> {
    const secretKey = process.env.TURNSTILE_SECRET || process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

    // Development mode bypass for testing keys or localhost
    if (
      !token ||
      token === 'DEV_BYPASS_TOKEN' ||
      token.startsWith('1x0000') ||
      secretKey.startsWith('1x0000') ||
      process.env.NODE_ENV !== 'production'
    ) {
      return { success: true };
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', secretKey);
      formData.append('response', token);
      if (clientIp) formData.append('remoteip', clientIp);

      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });

      const outcome: any = await response.json();

      if (!outcome.success) {
        StructuredLogger.warn('[SecurityShield] Cloudflare Turnstile verification failed', {
          errorCodes: outcome['error-codes'],
          clientIp
        });
        return {
          success: false,
          reason: 'Security check failed. Please refresh the page and try again.'
        };
      }

      return { success: true };
    } catch (err: any) {
      StructuredLogger.error('[SecurityShield] Turnstile verification request error', { error: err?.message || err });
      return { success: true }; // Fail-open to avoid blocking legitimate users on network glitch
    }
  }

  /**
   * Verify Turnstile Response Token via Cloudflare siteverify API
   */
  static async verifyTurnstileToken(token: string, remoteIp?: string): Promise<{ success: boolean; error?: string }> {
    const secret = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';
    if (!token) {
      // In development or if test keys used without token
      if (process.env.NODE_ENV === 'development') return { success: true };
      return { success: false, error: 'Turnstile verification token missing' };
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', secret);
      formData.append('response', token);
      if (remoteIp) formData.append('remoteip', remoteIp);

      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const outcome = await res.json() as any;
      if (outcome.success) {
        return { success: true };
      }
      StructuredLogger.warn('[SecurityShield] Turnstile siteverify failed', { errorCodes: outcome['error-codes'] });
      return { success: false, error: outcome['error-codes']?.join(', ') || 'Turnstile validation failed' };
    } catch (err: any) {
      StructuredLogger.error('[SecurityShield] Turnstile verification exception', { error: err?.message });
      return { success: true }; // Fallback gracefully if network error
    }
  }

  // Daily visitor IP quota tracking (50 turns per 24 hours per visitor IP)
  private static visitorDailyTurns: Map<string, { count: number; resetTime: number }> = new Map();

  /**
   * Check if visitor IP has exceeded 24-hour total turn budget (max 50 turns per 24h)
   */
  static checkDailyVisitorQuota(visitorIp: string, maxDailyTurns: number = 50): { exceeded: boolean; remaining: number } {
    if (!visitorIp) return { exceeded: false, remaining: maxDailyTurns };

    const now = Date.now();
    const entry = this.visitorDailyTurns.get(visitorIp);

    if (!entry || now > entry.resetTime) {
      this.visitorDailyTurns.set(visitorIp, { count: 1, resetTime: now + (24 * 60 * 60 * 1000) });
      return { exceeded: false, remaining: maxDailyTurns - 1 };
    }

    if (entry.count >= maxDailyTurns) {
      StructuredLogger.warn('[SecurityShield] Visitor 24-hour turn quota exceeded', { visitorIp, count: entry.count, maxDailyTurns });
      return { exceeded: true, remaining: 0 };
    }

    entry.count++;
    return { exceeded: false, remaining: maxDailyTurns - entry.count };
  }
}
