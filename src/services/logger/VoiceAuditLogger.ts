export interface VoiceAuditRecord {
  conversationId: string;
  userTranscript: string;
  detectedLanguage: 'Urdu' | 'English';
  embeddingGenerated: boolean;
  topMatches: { chunkId: string; similarity: number }[];
  similarityThreshold: number;
  highestSimilarity: number;
  decision: 'RAG' | 'OUT_OF_SCOPE';
  fallbackTriggered: boolean;
  gptInvoked: boolean;
  responseType: 'RAG' | 'Fallback';
  retrievedSources: number;
  voice: string;
  latencyMs: number;
  totalTokens?: number;
}

const PAD = 44;
const LINE = '─'.repeat(PAD);

function row(label: string, value: string): string {
  return `  ${label.padEnd(22)}: ${value}`;
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
      row('Detected Language', record.detectedLanguage),
      '',
      row('Embedding Generated', record.embeddingGenerated ? '✅ Yes' : '❌ No'),
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
