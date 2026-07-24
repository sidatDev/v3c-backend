import WebSocket from 'ws';
import { RealtimeSessionManager, VoiceSessionParams } from './RealtimeSessionManager';

export class VoiceService {
  /**
   * Handle incoming WebSocket realtime voice session
   */
  static handleRealtimeSession(socket: WebSocket, query: { sessionId?: string; agentId?: string; publicKey?: string; slug?: string; language?: string }): void {
    const params: VoiceSessionParams = {
      socket,
      sessionId: query.sessionId,
      agentId: query.agentId,
      publicKey: query.publicKey,
      slug: query.slug,
      language: query.language
    };

    const manager = new RealtimeSessionManager(params);
    manager.start().catch(err => {
      console.error('[VoiceService] Session startup error:', err);
    });
  }
}
