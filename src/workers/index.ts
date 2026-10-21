import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../lib/redis';

/**
 * Standard queue names corresponding to domain events
 */
export const QUEUE_NAMES = [
  'conversation',
  'usage',
  'audit',
  'lead',
  'webhook',
  'workflow',
  'token',
  'default',
] as const;

export type QueueName = typeof QUEUE_NAMES[number];

const workers: Map<string, Worker> = new Map();

/**
 * Placeholder processor for BullMQ workers.
 * Structured-logs job name, id, queue, and payload.
 */
export const placeholderProcessor = async (job: Job): Promise<{ success: boolean; processedAt: string }> => {
  const logData = {
    event: 'job.processed',
    queue: job.queueName,
    jobId: job.id,
    jobName: job.name,
    attemptsMade: job.attemptsMade,
    payload: job.data,
    timestamp: new Date().toISOString(),
  };

  console.log('[WORKER]', JSON.stringify(logData, null, 2));

  return {
    success: true,
    processedAt: new Date().toISOString(),
  };
};

/**
 * Bootstrap and start all queue workers
 */
export const startWorkers = async (): Promise<void> => {
  if (workers.size > 0) {
    console.log('[WORKER] Workers are already running.');
    return;
  }

  const connection = getRedisClient();

  for (const queueName of QUEUE_NAMES) {
    try {
      const worker = new Worker(queueName, placeholderProcessor, {
        connection,
        concurrency: 5,
      });

      worker.on('completed', (job: Job) => {
        console.log(`[WORKER] Queue '${queueName}' completed job '${job.name}' (ID: ${job.id})`);
      });

      worker.on('failed', (job: Job | undefined, err: Error) => {
        console.error(`[WORKER ERROR] Queue '${queueName}' failed job '${job?.name}' (ID: ${job?.id}):`, {
          message: err.message,
          stack: err.stack,
        });
      });

      worker.on('error', (err: Error) => {
        console.error(`[WORKER ERROR] Queue '${queueName}' encountered error:`, err.message);
      });

      workers.set(queueName, worker);
    } catch (err: any) {
      console.error(`[WORKER] Failed to initialize worker for queue '${queueName}':`, err.message);
    }
  }

  console.log(`[WORKER] Successfully bootstrapped ${workers.size} workers for queues: ${Array.from(workers.keys()).join(', ')}`);
};

/**
 * Gracefully stop all active workers
 */
export const stopWorkers = async (): Promise<void> => {
  if (workers.size === 0) {
    return;
  }

  console.log(`[WORKER] Stopping ${workers.size} worker(s)...`);
  const closePromises: Promise<void>[] = [];

  for (const [name, worker] of workers.entries()) {
    closePromises.push(
      worker.close().catch((err: any) => {
        console.warn(`[WORKER] Error stopping worker for queue '${name}':`, err.message);
      })
    );
  }

  await Promise.all(closePromises);
  workers.clear();
  console.log('[WORKER] All workers stopped gracefully.');
};
