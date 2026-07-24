export interface VoiceAuditRecord {
  conversationId: string;
  userTranscript: string;
  detectedLanguage: 'Urdu' | 'English' | 'RomanUrdu';
  dominantLanguage?: 'English' | 'Urdu' | 'RomanUrdu';
  previousSessionLanguage?: string;
  finalResponseLanguage?: string;
  greetingReplayDetected?: boolean;
  ignoredTranscript?: boolean;
  transcriptLength?: number;
  wordCount?: number;
  thinkingDelayMs?: number;
  vadTriggerReason?: string;
  retrievalLatencyMs?: number;
  embeddingGenerated: boolean;
  topMatches: { chunkId: string; similarity: number }[];
  similarityThreshold: number;
  highestSimilarity: number;
  decision: 'RAG' | 'OUT_OF_SCOPE' | 'IGNORED_NOISE';
  fallbackTriggered: boolean;
  gptInvoked: boolean;
  responseType: 'RAG' | 'Fallback' | 'Ignored';
  retrievedSources: number;
  voice: string;
  latencyMs: number;
  totalTokens?: number;
}

const PAD = 44;
const LINE = '─'.repeat(PAD);

function row(label: string, value: string): string {
  return `  ${label.padEnd(24)}: ${value}`;
}

export class VoiceAuditLogger {
  /**
   * Print the initial turn audit block (called immediately after RAG decision).
   * latencyMs and totalTokens are filled by printFinal() after response.done.
   */
  static print(record: VoiceAuditRecord): void {
    const transcript =
      record.userTranscript.length > 60
        ? record.userTranscript.substring(0, 60) + '…'
        : record.userTranscript;

    const lines: string[] = [
      '',
      `  ╔${'═'.repeat(PAD)}╗`,
      `  ║  VOICE TURN AUDIT LOG${' '.repeat(PAD - 22)}║`,
      `  ╚${'═'.repeat(PAD)}╝`,
      row('Conversation ID', record.conversationId),
      '',
      row('User Transcript', `"${transcript}"`),
      row('Transcript Length', `${record.transcriptLength ?? record.userTranscript.length} chars`),
      row('Word Count', `${record.wordCount ?? record.userTranscript.split(/\s+/).length} words`),
      row('Dominant Language', record.dominantLanguage || record.detectedLanguage),
      row('Previous Lang Memory', record.previousSessionLanguage || '(none)'),
      row('Final Response Lang', record.finalResponseLanguage || record.detectedLanguage),
      row('Ignored Transcript', record.ignoredTranscript ? '⚠️ Yes (Noise/Filler)' : '✅ No'),
      row('Greeting Replay Guard', record.greetingReplayDetected ? '⚠️ Replay Blocked' : '✅ Clean'),
      '',
      row('Embedding Generated', record.embeddingGenerated ? '✅ Yes' : '❌ No'),
      row('Retrieval Latency', `${record.retrievalLatencyMs ?? 0} ms`),
      row('Thinking Delay Added', `${record.thinkingDelayMs ?? 0} ms`),
      '',
      '  Top Matches:',
    ];

    if (record.topMatches.length > 0) {
      record.topMatches.forEach((m) => {
        lines.push(`    Chunk #${m.chunkId.padEnd(8)} ${m.similarity.toFixed(2)}`);
      });
    } else {
      lines.push('    (no chunks above threshold)');
    }

    lines.push(
      '',
      row('Similarity Threshold', record.similarityThreshold.toFixed(2)),
      row('Highest Similarity', record.highestSimilarity.toFixed(2)),
      '',
      row('Decision', record.decision),
      row('Fallback Triggered', record.fallbackTriggered ? '✅ Yes' : '❌ No'),
      row('GPT Invoked', record.gptInvoked ? '✅ Yes' : '❌ No'),
      row('Response Type', record.responseType),
      row('Retrieved Sources', String(record.retrievedSources)),
      row('Voice', record.voice),
      `  ${LINE}`,
      '  (awaiting response.done for latency / tokens…)',
    );

    console.log(lines.join('\n'));
  }

  /**
   * Print the final latency / token row after response.done arrives.
   */
  static printFinal(record: VoiceAuditRecord): void {
    const tokenStr =
      record.totalTokens !== undefined ? String(record.totalTokens) : 'N/A';

    const lines: string[] = [
      row('Latency', `${record.latencyMs} ms`),
      row('Total Tokens', tokenStr),
      `  ${'═'.repeat(PAD)}`,
      '',
    ];

    console.log(lines.join('\n'));
  }
}
