import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

export const openai = new OpenAI({
  apiKey: apiKey || 'dummy-key-for-initialization',
});

/**
 * Generate 1536-dimensional vector embedding using OpenAI text-embedding-3-small
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  if (!text || text.trim().length === 0) return [];
  
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.replace(/\n/g, ' '),
    });

    return response.data[0].embedding;
  } catch (error: any) {
    console.error('[OpenAI Embedding Error]:', error?.message || error);
    return [];
  }
};

/**
 * Split text into semantic chunks for vector storage & RAG retrieval
 */
export const chunkText = (text: string, maxChunkLength: number = 800): string[] => {
  if (!text) return [];

  const sentences = text.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChunkLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence + ' ';
    } else {
      currentChunk += sentence + ' ';
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
};
