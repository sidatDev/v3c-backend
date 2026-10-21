import app from './app';
import { startWorkers, stopWorkers } from './workers';
import { closeQueues } from './lib/queue';
import { closeRedis } from './lib/redis';

const PORT = parseInt(process.env.PORT || '3001');

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Received ${signal}. Gracefully stopping server and background tasks...`);

  try {
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await app.close();
    console.log('[SHUTDOWN] All resources closed cleanly. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('[SHUTDOWN ERROR] Error during shutdown:', err);
    process.exit(1);
  }
};

const start = async () => {
  try {
    const address = await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[SERVER] V3C Backend API running in '${process.env.NODE_ENV || 'development'}' mode at ${address}`);

    // Start background BullMQ workers
    try {
      await startWorkers();
    } catch (workerErr: any) {
      console.error('[SERVER] Failed to start background workers:', workerErr.message || workerErr);
    }
  } catch (err: any) {
    console.error('[CRITICAL] Server startup failed:', err.message || err);
    process.exit(1);
  }
};

start();

// Handle graceful shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle unhandled promise rejections
process.on('unhandledRejection', async (err: any) => {
  console.error('[CRITICAL] Unhandled Rejection:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  try {
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await app.close();
  } catch {
    // Ignore cleanup errors during critical crash
  }
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: any) => {
  console.error('[CRITICAL] Uncaught Exception:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});

