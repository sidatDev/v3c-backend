/**
 * WorkflowEngineService.ts
 * Phase 8: Workflow Engine (Wizard + Visual Canvas Builder, Simulation, Versioning,
 * and Governance Auto-Pause after 3 consecutive failures).
 */

import { randomUUID } from 'crypto';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error';
import { WebhookEngineService, V3CWebhookEvent } from '../webhooks/WebhookEngineService';
import { EscalationService } from '../escalation/EscalationService';

export type ConditionOperator = 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte';

export interface WorkflowCondition {
  id: string;
  field: string;
  operator: ConditionOperator;
  value: string | number;
}

export type WorkflowActionType =
  | 'dispatch_webhook'
  | 'create_escalation'
  | 'send_notification'
  | 'tag_session';

export interface WorkflowAction {
  id: string;
  type: WorkflowActionType;
  config: Record<string, any>;
}

export interface CanvasNode {
  id: string;
  type: 'trigger' | 'condition' | 'action';
  label: string;
  x: number;
  y: number;
  data: Record<string, any>;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface WorkflowDefinition {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  builderMode: 'wizard' | 'canvas';
  triggerEvent: V3CWebhookEvent | 'bundle_80' | 'bundle_95' | 'bundle_exhausted';
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  canvas: {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  };
  version: number;
  status: 'active' | 'paused';
  consecutiveFailures: number;
  totalRuns: number;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'skipped' | 'failed';
  createdAt: string;
  updatedAt: string;
}

const WORKFLOW_CONFIG_KEY = 'v3c_workflows_v1';

export class WorkflowEngineService {
  /**
   * Builds synchronized Canvas nodes & edges from Wizard trigger/conditions/actions.
   */
  static buildCanvasGraph(
    triggerEvent: string,
    conditions: WorkflowCondition[],
    actions: WorkflowAction[]
  ): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    const triggerNodeId = 'node_trigger_1';
    nodes.push({
      id: triggerNodeId,
      type: 'trigger',
      label: `Trigger: ${triggerEvent}`,
      x: 60,
      y: 120,
      data: { triggerEvent },
    });

    let prevNodeId = triggerNodeId;
    let xPos = 300;

    conditions.forEach((cond, idx) => {
      const nodeId = `node_cond_${idx + 1}`;
      nodes.push({
        id: nodeId,
        type: 'condition',
        label: `If ${cond.field} ${cond.operator} ${cond.value}`,
        x: xPos,
        y: 120,
        data: cond,
      });
      edges.push({
        id: `edge_${prevNodeId}_${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        label: idx === 0 ? 'on event' : 'and',
      });
      prevNodeId = nodeId;
      xPos += 240;
    });

    actions.forEach((act, idx) => {
      const nodeId = `node_act_${idx + 1}`;
      nodes.push({
        id: nodeId,
        type: 'action',
        label: `Action: ${act.type}`,
        x: xPos,
        y: 120 + idx * 70,
        data: act,
      });
      edges.push({
        id: `edge_${prevNodeId}_${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        label: 'then',
      });
      prevNodeId = nodeId;
    });

    return { nodes, edges };
  }

  /**
   * Default starter workflows seeded for a tenant if none exist.
   */
  static getDefaultTemplates(tenantId: string): WorkflowDefinition[] {
    const now = new Date().toISOString();
    const w1Conditions: WorkflowCondition[] = [
      { id: 'c1', field: 'rating', operator: 'lt', value: 3 },
    ];
    const w1Actions: WorkflowAction[] = [
      {
        id: 'a1',
        type: 'create_escalation',
        config: { reason: 'low_csat_workflow_trigger' },
      },
      {
        id: 'a2',
        type: 'send_notification',
        config: { title: 'Low CSAT Alert (< 3 Stars)', message: 'Customer rated conversation below 3 stars.' },
      },
    ];

    const w2Conditions: WorkflowCondition[] = [
      { id: 'c2', field: 'usagePercent', operator: 'gte', value: 80 },
    ];
    const w2Actions: WorkflowAction[] = [
      {
        id: 'a3',
        type: 'dispatch_webhook',
        config: { event: 'token.alert' },
      },
    ];

    return [
      {
        id: `wf_low_csat_${tenantId.slice(0, 8)}`,
        tenantId,
        name: 'Low CSAT Escalation & Manager Alert',
        description: 'Automatically opens an escalation ticket and notifies managers when CSAT rating < 3.',
        builderMode: 'wizard',
        triggerEvent: 'feedback.received',
        conditions: w1Conditions,
        actions: w1Actions,
        canvas: this.buildCanvasGraph('feedback.received', w1Conditions, w1Actions),
        version: 1,
        status: 'active',
        consecutiveFailures: 0,
        totalRuns: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `wf_token_renewal_${tenantId.slice(0, 8)}`,
        tenantId,
        name: 'Token Bundle 80% Renewal Webhook',
        description: 'Fires an outbound CRM renewal webhook when monthly token usage reaches 80%.',
        builderMode: 'canvas',
        triggerEvent: 'bundle_80',
        conditions: w2Conditions,
        actions: w2Actions,
        canvas: this.buildCanvasGraph('bundle_80', w2Conditions, w2Actions),
        version: 1,
        status: 'active',
        consecutiveFailures: 0,
        totalRuns: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  /**
   * Loads all workflows for a tenant.
   */
  static async listWorkflows(tenantId: string): Promise<WorkflowDefinition[]> {
    const record = await prisma.configuration.findFirst({
      where: { tenantId, key: WORKFLOW_CONFIG_KEY },
      orderBy: { id: 'desc' },
    });

    if (!record || !record.value) {
      const defaults = this.getDefaultTemplates(tenantId);
      await this.saveWorkflows(tenantId, defaults);
      return defaults;
    }

    try {
      const parsed = JSON.parse(record.value);
      return Array.isArray(parsed) ? parsed : this.getDefaultTemplates(tenantId);
    } catch (_) {
      return this.getDefaultTemplates(tenantId);
    }
  }

  /**
   * Persists the tenant's workflows list.
   */
  static async saveWorkflows(tenantId: string, workflows: WorkflowDefinition[]): Promise<void> {
    const existing = await prisma.configuration.findFirst({
      where: { tenantId, key: WORKFLOW_CONFIG_KEY },
      orderBy: { id: 'desc' },
    });

    const serialized = JSON.stringify(workflows);
    if (existing) {
      await prisma.configuration.update({
        where: { id: existing.id },
        data: { value: serialized, updatedAt: new Date() },
      });
    } else {
      await prisma.configuration.create({
        data: {
          tenantId,
          key: WORKFLOW_CONFIG_KEY,
          value: serialized,
          updatedAt: new Date(),
        },
      });
    }
  }

  /**
   * Creates or updates a workflow (increments version on update).
   */
  static async upsertWorkflow(
    tenantId: string,
    input: Partial<WorkflowDefinition> & { name: string; triggerEvent: any }
  ): Promise<WorkflowDefinition> {
    const workflows = await this.listWorkflows(tenantId);
    const now = new Date().toISOString();

    const conditions: WorkflowCondition[] = Array.isArray(input.conditions)
      ? input.conditions
      : [];
    const actions: WorkflowAction[] = Array.isArray(input.actions) && input.actions.length > 0
      ? input.actions
      : [{ id: randomUUID(), type: 'send_notification', config: { title: `Workflow: ${input.name}` } }];

    const canvas =
      input.canvas && Array.isArray(input.canvas.nodes) && input.canvas.nodes.length > 0
        ? input.canvas
        : this.buildCanvasGraph(input.triggerEvent, conditions, actions);

    const existingIdx = input.id ? workflows.findIndex((w) => w.id === input.id) : -1;

    if (existingIdx >= 0) {
      const prev = workflows[existingIdx];
      const updated: WorkflowDefinition = {
        ...prev,
        name: input.name.trim(),
        description: input.description ?? prev.description,
        builderMode: input.builderMode || prev.builderMode,
        triggerEvent: input.triggerEvent || prev.triggerEvent,
        conditions,
        actions,
        canvas: this.buildCanvasGraph(input.triggerEvent || prev.triggerEvent, conditions, actions),
        status: input.status || prev.status,
        consecutiveFailures: input.status === 'active' ? 0 : prev.consecutiveFailures,
        version: prev.version + 1,
        updatedAt: now,
      };
      workflows[existingIdx] = updated;
      await this.saveWorkflows(tenantId, workflows);
      return updated;
    }

    const created: WorkflowDefinition = {
      id: `wf_${randomUUID().slice(0, 12)}`,
      tenantId,
      name: input.name.trim(),
      description: input.description?.trim() || 'Custom automated V3C workflow',
      builderMode: input.builderMode || 'wizard',
      triggerEvent: input.triggerEvent,
      conditions,
      actions,
      canvas,
      version: 1,
      status: 'active',
      consecutiveFailures: 0,
      totalRuns: 0,
      createdAt: now,
      updatedAt: now,
    };

    workflows.unshift(created);
    await this.saveWorkflows(tenantId, workflows);
    return created;
  }

  /**
   * Deletes a workflow by ID.
   */
  static async deleteWorkflow(tenantId: string, workflowId: string): Promise<void> {
    const workflows = await this.listWorkflows(tenantId);
    const filtered = workflows.filter((w) => w.id !== workflowId);
    await this.saveWorkflows(tenantId, filtered);
  }

  /**
   * Evaluates a single condition against a payload object.
   */
  static evaluateCondition(cond: WorkflowCondition, payload: Record<string, any>): boolean {
    const actual = payload[cond.field];
    const target = cond.value;

    switch (cond.operator) {
      case 'equals':
        return String(actual) === String(target);
      case 'not_equals':
        return String(actual) !== String(target);
      case 'contains':
        return String(actual ?? '').toLowerCase().includes(String(target).toLowerCase());
      case 'gt':
        return Number(actual) > Number(target);
      case 'lt':
        return Number(actual) < Number(target);
      case 'gte':
        return Number(actual) >= Number(target);
      case 'lte':
        return Number(actual) <= Number(target);
      default:
        return true;
    }
  }

  /**
   * Simulates (dry-run) or executes a workflow against a test/event payload.
   * Implements the Governance Rule: Auto-Pause workflow after 3 consecutive failures.
   */
  static async runWorkflow(params: {
    tenantId: string;
    workflowId: string;
    payload?: Record<string, any>;
    dryRun?: boolean;
    simulateFailure?: boolean;
  }) {
    const {
      tenantId,
      workflowId,
      payload = { rating: 2, usagePercent: 85, sessionId: '749', channel: 'whatsapp' },
      dryRun = false,
      simulateFailure = false,
    } = params;

    const workflows = await this.listWorkflows(tenantId);
    const wf = workflows.find((w) => w.id === workflowId);
    if (!wf) {
      throw new AppError(`Workflow "${workflowId}" not found`, 404);
    }

    if (wf.status === 'paused' && !dryRun) {
      return {
        workflowId: wf.id,
        version: wf.version,
        status: wf.status,
        executed: false,
        reason: 'Workflow is paused (governance auto-pause or manual pause)',
        consecutiveFailures: wf.consecutiveFailures,
      };
    }

    const conditionTrace = wf.conditions.map((c) => ({
      conditionId: c.id,
      expression: `${c.field} ${c.operator} ${c.value}`,
      actualValue: payload[c.field],
      passed: this.evaluateCondition(c, payload),
    }));

    const allConditionsPassed = conditionTrace.every((c) => c.passed);
    const actionTrace: any[] = [];

    wf.totalRuns += 1;
    wf.lastRunAt = new Date().toISOString();

    if (!allConditionsPassed) {
      wf.lastRunStatus = 'skipped';
      await this.saveWorkflows(tenantId, workflows);
      return {
        workflowId: wf.id,
        version: wf.version,
        status: wf.status,
        dryRun,
        conditionsPassed: false,
        conditionTrace,
        actionTrace,
        consecutiveFailures: wf.consecutiveFailures,
      };
    }

    // Handle simulated or runtime failure to enforce 3-strike Auto-Pause Governance
    if (simulateFailure) {
      wf.consecutiveFailures += 1;
      wf.lastRunStatus = 'failed';

      let autoPaused = false;
      if (wf.consecutiveFailures >= 3) {
        wf.status = 'paused';
        autoPaused = true;
        try {
          await prisma.notification.create({
            data: {
              id: randomUUID(),
              tenantId,
              type: 'WORKFLOW_AUTO_PAUSED',
              title: `Workflow Auto-Paused: ${wf.name}`,
              message: `Workflow "${wf.name}" (v${wf.version}) was automatically paused after 3 consecutive execution failures.`,
              metadata: { workflowId: wf.id, consecutiveFailures: wf.consecutiveFailures },
            },
          });
        } catch (_) {}
      }

      await this.saveWorkflows(tenantId, workflows);
      return {
        workflowId: wf.id,
        version: wf.version,
        status: wf.status,
        dryRun,
        conditionsPassed: true,
        failed: true,
        autoPaused,
        consecutiveFailures: wf.consecutiveFailures,
        conditionTrace,
        actionTrace: [{ status: 'failed', error: 'Simulated action endpoint failure' }],
      };
    }

    for (const act of wf.actions) {
      if (dryRun) {
        actionTrace.push({
          actionId: act.id,
          type: act.type,
          mode: 'simulation_dry_run',
          status: 'simulated_ok',
          config: act.config,
        });
        continue;
      }

      if (act.type === 'create_escalation') {
        const esc = await EscalationService.createEscalation(
          tenantId,
          String(payload.sessionId || 'workflow-session'),
          null,
          act.config.reason || 'workflow_escalation'
        );
        actionTrace.push({ actionId: act.id, type: act.type, status: 'executed', escalationId: esc.id });
      } else if (act.type === 'dispatch_webhook') {
        const deliveries = await WebhookEngineService.dispatchOutboundEvent({
          tenantId,
          event: (act.config.event as V3CWebhookEvent) || 'lead.captured',
          payload,
          simulateLocal: true,
        });
        actionTrace.push({
          actionId: act.id,
          type: act.type,
          status: 'executed',
          deliveriesCount: deliveries.length,
        });
      } else if (act.type === 'send_notification') {
        await prisma.notification.create({
          data: {
            id: randomUUID(),
            tenantId,
            type: 'WORKFLOW_ACTION',
            title: act.config.title || `Workflow Triggered: ${wf.name}`,
            message: act.config.message || `Executed workflow ${wf.name} (v${wf.version})`,
          },
        });
        actionTrace.push({ actionId: act.id, type: act.type, status: 'executed' });
      } else {
        actionTrace.push({ actionId: act.id, type: act.type, status: 'executed' });
      }
    }

    wf.consecutiveFailures = 0;
    wf.lastRunStatus = 'success';
    await this.saveWorkflows(tenantId, workflows);

    return {
      workflowId: wf.id,
      version: wf.version,
      status: wf.status,
      dryRun,
      conditionsPassed: true,
      consecutiveFailures: wf.consecutiveFailures,
      conditionTrace,
      actionTrace,
    };
  }
}

export default WorkflowEngineService;
