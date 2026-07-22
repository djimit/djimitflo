/**
 * LifecycleManager — centralized shutdown coordinator for all background services.
 *
 * Prevents memory leaks by ensuring all timers, intervals, and background
 * processes are properly cleaned up on SIGTERM/SIGINT.
 *
 * Services register themselves at startup. On shutdown, they are stopped
 * in reverse initialization order.
 */

export interface Stoppable {
  stop(): void | Promise<void>;
  readonly serviceName: string;
}

export class LifecycleManager {
  private services: Stoppable[] = [];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Register a service for lifecycle management.
   */
  register(service: Stoppable): void {
    this.services.push(service);
  }

  /**
   * Initialize signal handlers for graceful shutdown.
   */
  initSignalHandlers(server: { close(callback: () => void): void }): void {
    const shutdown = (signal: string) => {
      if (this.shuttingDown) {
        console.log(`⚠️  ${signal} received during shutdown, ignoring...`);
        return;
      }

      this.shuttingDown = true;
      console.log(`⚠️  ${signal} received, shutting down gracefully...`);

      this.shutdownPromise = this.shutdown(server);
      this.shutdownPromise.catch((err) => {
        console.error('❌ Shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      console.error('⚠️  Unhandled rejection:', reason);
    });
  }

  /**
   * Execute graceful shutdown sequence.
   */
  private async shutdown(server: { close(callback: () => void): void }): Promise<void> {
    const startTime = Date.now();

    // 1. Stop accepting new connections
    console.log('  1/3 Stopping HTTP server...');
    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('     ✓ HTTP server closed');
        resolve();
      });

      setTimeout(() => {
        console.log('     ⚠ HTTP server close timeout, forcing...');
        resolve();
      }, 10_000);
    });

    // 2. Stop all background services (reverse order)
    console.log(`  2/3 Stopping ${this.services.length} background services...`);
    const reversed = [...this.services].reverse();

    for (const service of reversed) {
      try {
        const serviceStart = Date.now();
        await service.stop();
        const elapsed = Date.now() - serviceStart;
        console.log(`     ✓ ${service.serviceName} (${elapsed}ms)`);
      } catch (error) {
        console.error(`     ✗ ${service.serviceName} failed:`, error);
      }
    }

    // 3. Final cleanup
    console.log('  3/3 Shutdown complete');
    const totalElapsed = Date.now() - startTime;
    console.log(`👋 Graceful shutdown completed in ${totalElapsed}ms`);
  }

  /**
   * Get the number of registered services.
   */
  get serviceCount(): number {
    return this.services.length;
  }
}

export const lifecycleManager = new LifecycleManager();
