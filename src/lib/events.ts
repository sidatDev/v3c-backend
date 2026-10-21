/**
 * Typed Event Catalog for V3C Event Bus
 */

export const EVENTS = {
  CONVERSATION_STARTED: 'conversation.started',
  CONVERSATION_ENDED: 'conversation.ended',
  USAGE_RECORDED: 'usage.recorded',
  AUDIT_APPEND: 'audit.append',
  LEAD_CAPTURED: 'lead.captured',
  LEAD_QUALIFIED: 'lead.qualified',
  WEBHOOK_DISPATCH: 'webhook.dispatch',
  WORKFLOW_TRIGGER: 'workflow.trigger',
  TOKEN_ALERT: 'token.alert',
} as const;

export type EventKey = keyof typeof EVENTS;
export type EventName = typeof EVENTS[EventKey];

export interface ConversationStartedPayload {
  conversationId: string;
  tenantId: string;
  agentId?: string;
  channel?: 'voice' | 'chat' | 'whatsapp' | string;
  startedAt: string;
  metadata?: Record<string, any>;
}

export interface ConversationEndedPayload {
  conversationId: string;
  tenantId: string;
  agentId?: string;
  durationSeconds: number;
  endedAt: string;
  reason?: 'user_disconnect' | 'timeout' | 'completed' | 'escalated' | string;
  metadata?: Record<string, any>;
}

export interface UsageRecordedPayload {
  tenantId: string;
  metric: 'tokens' | 'minutes' | 'leads' | 'search_queries' | string;
  quantity: number;
  unit?: string;
  recordedAt: string;
  context?: {
    agentId?: string;
    conversationId?: string;
    model?: string;
    [key: string]: any;
  };
}

export interface AuditAppendPayload {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  diff?: Record<string, any>;
  timestamp: string;
  ipAddress?: string;
}

export interface LeadCapturedPayload {
  leadId: string;
  tenantId: string;
  source?: string;
  contactInfo: {
    name?: string;
    email?: string;
    phone?: string;
    [key: string]: any;
  };
  capturedAt: string;
}

export interface LeadQualifiedPayload {
  leadId: string;
  tenantId: string;
  score: number;
  qualificationNotes?: string;
  qualifiedAt: string;
  metadata?: Record<string, any>;
}

export interface WebhookDispatchPayload {
  webhookId?: string;
  tenantId: string;
  event: string;
  targetUrl: string;
  payload: Record<string, any>;
  attempt?: number;
  timestamp: string;
}

export interface WorkflowTriggerPayload {
  workflowId: string;
  tenantId: string;
  triggerEvent: string;
  inputData: Record<string, any>;
  triggeredAt: string;
}

export interface TokenAlertPayload {
  tenantId: string;
  currentBalance: number;
  threshold: number;
  alertType: 'warning' | 'critical' | 'depleted';
  timestamp: string;
}

/**
 * Mapping of event names to their payload types
 */
export interface EventPayloadMap {
  [EVENTS.CONVERSATION_STARTED]: ConversationStartedPayload;
  [EVENTS.CONVERSATION_ENDED]: ConversationEndedPayload;
  [EVENTS.USAGE_RECORDED]: UsageRecordedPayload;
  [EVENTS.AUDIT_APPEND]: AuditAppendPayload;
  [EVENTS.LEAD_CAPTURED]: LeadCapturedPayload;
  [EVENTS.LEAD_QUALIFIED]: LeadQualifiedPayload;
  [EVENTS.WEBHOOK_DISPATCH]: WebhookDispatchPayload;
  [EVENTS.WORKFLOW_TRIGGER]: WorkflowTriggerPayload;
  [EVENTS.TOKEN_ALERT]: TokenAlertPayload;
}
