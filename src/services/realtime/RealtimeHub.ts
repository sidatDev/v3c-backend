/**
 * RealtimeHub.ts
 * Tenant-scoped WebSocket broadcast hub for Phase 4 Live Human Takeover,
 * Escalation Alerts, Silent-Listener Updates, and CSAT notifications.
 */

import WebSocket from 'ws';

export type RealtimeEventType =
  | 'escalation_created'
  | 'session_takeover'
  | 'session_handback'
  | 'new_message'
  | 'csat_submitted';

export interface RealtimeEventMessage {
  event: RealtimeEventType;
  tenantId: string;
  timestamp: string;
  payload: Record<string, any>;
}

export class RealtimeHub {
  private static clients = new Map<string, Set<WebSocket>>();

  /**
   * Registers an active WebSocket connection under a tenantId.
   */
  static registerClient(tenantId: string, socket: WebSocket): void {
    if (!tenantId) return;

    let tenantSet = this.clients.get(tenantId);
    if (!tenantSet) {
      tenantSet = new Set<WebSocket>();
      this.clients.set(tenantId, tenantSet);
    }

    tenantSet.add(socket);

    const cleanup = () => {
      const currentSet = this.clients.get(tenantId);
      if (currentSet) {
        currentSet.delete(socket);
        if (currentSet.size === 0) {
          this.clients.delete(tenantId);
        }
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // Send initial connection ack
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            event: 'connected',
            tenantId,
            timestamp: new Date().toISOString(),
            payload: { message: 'Connected to V3C Realtime Hub' },
          })
        );
      }
    } catch (_) {
      // Ignore send errors on initial handshake
    }
  }

  /**
   * Broadcasts an event to all connected admin clients for a specific tenant.
   */
  static broadcast(
    tenantId: string,
    event: RealtimeEventType,
    payload: Record<string, any>
  ): void {
    if (!tenantId) return;

    const tenantSet = this.clients.get(tenantId);
    if (!tenantSet || tenantSet.size === 0) return;

    const message: RealtimeEventMessage = {
      event,
      tenantId,
      timestamp: new Date().toISOString(),
      payload,
    };

    const raw = JSON.stringify(message);

    for (const socket of tenantSet) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(raw);
        }
      } catch (err) {
        console.warn(`[RealtimeHub] Failed to send ${event} to client:`, err);
      }
    }
  }

  /**
   * Returns number of connected clients for a tenant (for diagnostics/testing).
   */
  static getClientCount(tenantId: string): number {
    return this.clients.get(tenantId)?.size ?? 0;
  }
}

export default RealtimeHub;
