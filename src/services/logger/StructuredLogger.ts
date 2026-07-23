export interface LogPayload {
  event?: string;
  tenantId?: string | null;
  sessionId?: string | number | null;
  mode?: 'chat' | 'voice' | 'system';
  retrievedChunks?: number;
  avgSimilarity?: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  toolCalls?: string[];
  errors?: string[];
  [key: string]: any;
}

export class StructuredLogger {
  static info(message: string, payload?: LogPayload): void {
    console.log(
      JSON.stringify({
        level: 'INFO',
        timestamp: new Date().toISOString(),
        message,
        ...payload
      })
    );
  }

  static warn(message: string, payload?: LogPayload): void {
    console.warn(
      JSON.stringify({
        level: 'WARN',
        timestamp: new Date().toISOString(),
        message,
        ...payload
      })
    );
  }

  static error(message: string, payload?: LogPayload): void {
    console.error(
      JSON.stringify({
        level: 'ERROR',
        timestamp: new Date().toISOString(),
        message,
        ...payload
      })
    );
  }
}
