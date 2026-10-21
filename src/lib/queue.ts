import { Queue, JobsOptions, Job } from 'bullmq';
import { getRedisClient } from './redis';
import { EventPayloadMap, EventName } from './events';

/**
 * Default job options as specified by target architecture
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

const queueRegistry = new Map<string, Queue>();

/**
 * Returns or registers a BullMQ Queue instance.
 */
export const getQueue = (name: string): Queue => {
  let queue = queueRegistry.get(name);
  if (!queue) {
    const connection = getRedisClient();
    queue = new Queue(name, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queueRegistry.set(name, queue);
  }
  return queue;
};

/**
 * Resolves the queue name for a given event, using domain prefix before dot.
 * E.g., 'conversation.started' -> 'conversation'
 */
export const getQueueNameForEvent = (event: string): string => {
  const [prefix] = event.split('.');
  return prefix || 'default';
};

/**
 * Publishes a typed event and its payload to the appropriate queue.
 */
export const publish = async <T extends keyof EventPayloadMap>(
  event: T,
  payload: EventPayloadMap[T],
  opts?: JobsOptions
): Promise<Job<EventPayloadMap[T]>> => {
  const queueName = getQueueNameForEvent(event);
  const queue = getQueue(queueName);

  const job = await queue.add(event, payload, {
    ...DEFAULT_JOB_OPTIONS,
    ...opts,
  });

  return job;
};

/**
 * Returns all currently registered queues.
 */
export const getAllQueues = (): Queue[] => {
  return Array.from(queueRegistry.values());
};

/**
 * Gracefully close all registered queues.
 */
export const closeQueues = async (): Promise<void> => {
  console.log(`[QUEUE] Closing ${queueRegistry.size} registered queue(s)...`);
  for (const [name, queue] of queueRegistry.entries()) {
    try {
      await queue.close();
    } catch (err: any) {
      console.warn(`[QUEUE] Error closing queue ${name}:`, err.message);
    }
  }
  queueRegistry.clear();
};
