import app from './app';

const PORT = parseInt(process.env.PORT || '3001');

const start = async () => {
  try {
    const address = await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[SERVER] V3C Backend API running in '${process.env.NODE_ENV || 'development'}' mode at ${address}`);
  } catch (err: any) {
    console.error('[CRITICAL] Server startup failed:', err.message || err);
    process.exit(1);
  }
};

start();

// Handle unhandled promise rejections
process.on('unhandledRejection', (err: any) => {
  console.error('[CRITICAL] Unhandled Rejection:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  app.close().then(() => {
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: any) => {
  console.error('[CRITICAL] Uncaught Exception:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
