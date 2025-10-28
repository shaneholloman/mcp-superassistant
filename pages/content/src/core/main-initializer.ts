/**
 * Main Application Initializer (Session 10)
 *
 * This module orchestrates the complete initialization sequence for the MCP SuperAssistant
 * application, ensuring all components are initialized in the correct order with proper
 * dependency management and error handling.
 */

import { eventBus, initializeEventBus } from '../events';
import {
  useAppStore,
  useConnectionStore,
  useToolStore,
  useUIStore,
  useAdapterStore,
  initializeAllStores,
} from '../stores';
import { globalErrorHandler, performanceMonitor, circuitBreaker, contextBridge } from '../core';
import { pluginRegistry, cleanupPluginSystem, createPluginContext } from '../plugins';
import { initializeGlobalEventHandlers, cleanupGlobalEventHandlers } from '../events/event-handlers';
import { logMessage } from '../utils/helpers';
import { createLogger } from '@extension/shared/lib/logger';
import { initializeAnalyticsListeners, startPeriodicSessionTracking, stopPeriodicSessionTracking } from '../analytics-listener';

// Simple logger implementation

const logger = createLogger('MainInitializer');

// class Logger {
//   constructor(private prefix: string) {}

//   log(message: string, ...args: any[]): void {
//     logMessage(`${this.prefix} ${message}`);
//     if (args.length > 0) {
//       logger.debug(...args);
//     }
//   }

//   warn(message: string, ...args: any[]): void {
//     logger.warn(`${this.prefix} ${message}`, ...args);
//   }

//   error(message: string, ...args: any[]): void {
//     logger.error(`${this.prefix} ${message}`, ...args);
//   }
// }

// const logger = new Logger('[MainInitializer]');

let isInitialized = false;
let isApplicationStateInitialized = false;
let initializationStartTime = 0;

/**
 * Initialize core services in the correct order
 */
async function initializeCoreServices(): Promise<void> {
  logger.debug('Initializing core services...');

  // 1. Environment Setup
  if (process.env.NODE_ENV === 'development') {
    logger.debug('Development mode enabled.');
    // Expose utilities to window for debugging if in a browser context
    if (typeof window !== 'undefined') {
      (window as any)._appDebug = {
        eventBus,
        stores: {
          app: useAppStore,
          connection: useConnectionStore,
          tool: useToolStore,
          ui: useUIStore,
          adapter: useAdapterStore,
        },
        services: {
          globalErrorHandler,
          performanceMonitor,
          circuitBreaker,
          contextBridge,
        },
        getStats: () => ({
          performance: performanceMonitor.getStats(),
          errors: globalErrorHandler.getErrorStats(),
          circuitBreaker: circuitBreaker.getStats(),
        }),
        clearData: () => {
          performanceMonitor.clear();
          globalErrorHandler.clearErrorReports();
        },
      };
      logger.debug('Debug utilities exposed on window._appDebug');
    }
  }

  // 2. Event Bus
  await initializeEventBus();
  logger.debug('Event bus initialized.');

  // 3. Core Architectural Components
  globalErrorHandler.initialize(eventBus, circuitBreaker);
  logger.debug('GlobalErrorHandler initialized.');

  performanceMonitor.initialize(eventBus);
  logger.debug('PerformanceMonitor initialized.');

  circuitBreaker.initialize({ eventBus });
  logger.debug('CircuitBreaker initialized.');

  contextBridge.initialize();
  logger.debug('ContextBridge initialized.');

  // 4. Global Event Handlers
  initializeGlobalEventHandlers();
  logger.debug('GlobalEventHandlers initialized.');

  // 5. Stores - Initialize all Zustand stores
  await performanceMonitor.time('store-initialization', async () => {
    await initializeAllStores();
  });
  logger.debug('All stores initialized.');
}

/**
 * Initialize plugin system with context
 */
async function initializePluginSystem(): Promise<void> {
  logger.debug('Initializing plugin system...');

  await performanceMonitor.time('plugin-system-initialization', async () => {
    // Create plugin context - the function only takes plugin name
    const pluginContext = createPluginContext('system');

    // Initialize plugin registry with the context
    await pluginRegistry.initialize(pluginContext);

    logger.debug('Plugin system initialized successfully.');
  });
}

/**
 * Activate sidebar plugin for universal sidebar functionality
 */
async function activateSidebarPlugin(): Promise<void> {
  logger.debug('Activating sidebar plugin...');

  try {
    await performanceMonitor.time('sidebar-plugin-activation', async () => {
      // Activate the sidebar plugin which will auto-show the sidebar
      await pluginRegistry.activatePlugin('sidebar-plugin');
      logger.debug('Sidebar plugin activated successfully.');
    });
  } catch (error) {
    logger.error('Failed to activate sidebar plugin:', error);
    // Don't throw - sidebar is not critical for app functionality
    // The app can still work without the sidebar
  }
}

/**
 * Initialize application state and trigger initial actions
 */
async function initializeApplicationState(): Promise<void> {
  if (isApplicationStateInitialized) {
    logger.warn('Application state already initialized, skipping.');
    return;
  }
  
  logger.debug('Initializing application state...');

  await performanceMonitor.time('app-state-initialization', async () => {
    // Initialize AppStore (loads settings, determines current site, etc.)
    if (!useAppStore.getState().isInitialized) {
      await useAppStore.getState().initialize();
      logger.debug('AppStore initialized (settings loaded, etc.).');
    }

    // Set current site information (if in a content script context)
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
      const hostname = window.location.hostname;
      const site = window.location.href;

      // Import plugin registry first and set initial activation flag
      const { pluginRegistry } = await import('../plugins/plugin-registry');
      
      // Set the flag before any operations that might trigger events
      pluginRegistry.setInitialActivationFlag(true);
      
      try {
        // Update app store with current site (this will emit 'app:site-changed')
        useAppStore.getState().setCurrentSite({ site, host: hostname });
        logger.debug(`Current site set to: ${hostname}`);

        // Auto-activate appropriate adapter for the current hostname
        logger.debug(`Attempting to auto-activate adapter for hostname: ${hostname}`);
        await pluginRegistry.activatePluginForHostname(hostname, true); // Pass true for initial activation
        logger.debug(`Adapter auto-activation completed for hostname: ${hostname}`);
      } finally {
        // Clear the flag after all operations are complete
        pluginRegistry.setInitialActivationFlag(false);
      }
    }

    // Check for connection configuration and attempt initial connection
    const connectionStore = useConnectionStore.getState();
    const serverConfig = connectionStore.serverConfig;

    if (serverConfig && serverConfig.uri) {
      logger.debug('Server configuration found, connection will be handled by background script and MCP client');
      await circuitBreaker.execute(async () => {
        // Don't set 'connecting' status here - let the background script and MCP client handle connection status
        // The actual connection logic is handled by the background script and MCP client
        logger.debug('Deferring connection management to background script');
      }, 'config-check');
    }
  });
  
  isApplicationStateInitialized = true;
  logger.debug('Application state initialization completed.');
}

/**
 * Main application initialization function
 */
export async function applicationInit(): Promise<void> {
  if (isInitialized) {
    logger.warn('Application already initialized.');
    return;
  }

  initializationStartTime = performance.now();
  logger.debug('Application initialization started...');

  try {
    // Mark initialization start
    performanceMonitor.mark('app-init-start');

    // Initialize core services first
    await initializeCoreServices();
    performanceMonitor.mark('core-services-initialized');

    // Initialize plugin system
    await initializePluginSystem();
    performanceMonitor.mark('plugin-system-initialized');

    // Activate sidebar plugin for universal sidebar functionality
    await activateSidebarPlugin();
    performanceMonitor.mark('sidebar-plugin-activated');

    // Initialize application state
    await initializeApplicationState();
    performanceMonitor.mark('app-state-initialized');

    // Initialize analytics listeners
    initializeAnalyticsListeners();
    startPeriodicSessionTracking();
    performanceMonitor.mark('analytics-initialized');

    // Mark initialization complete
    performanceMonitor.mark('app-init-complete');

    // Measure total initialization time
    const initializationTime = performance.now() - initializationStartTime;
    performanceMonitor.measure('total-initialization', 'app-init-start', 'app-init-complete');

    isInitialized = true;
    logger.debug(`Application initialization completed successfully in ${initializationTime.toFixed(2)}ms`);

    // Emit initialization complete event
    eventBus.emit('app:initialized', {
      version: '1.0.0', // TODO: Get from package.json or environment
      timestamp: Date.now(),
      initializationTime,
    });
  } catch (error) {
    const initializationTime = performance.now() - initializationStartTime;
    logger.error(`Application initialization failed after ${initializationTime.toFixed(2)}ms:`, error);

    // The globalErrorHandler should catch this if it's set up to handle early errors
    globalErrorHandler.handleError(
      error instanceof Error ? error : new Error(String(error)),
      {
        component: 'main-initializer',
        operation: 'application-initialization',
        metadata: { initializationTime },
      },
      'critical',
    );

    eventBus.emit('app:initialization-failed', {
      error: error instanceof Error ? error : new Error(String(error)),
      timestamp: Date.now(),
      initializationTime,
    });

    throw error; // Re-throw to indicate failure if necessary
  }
}

/**
 * Application cleanup function
 */
export async function applicationCleanup(): Promise<void> {
  if (!isInitialized) {
    logger.warn('Application not initialized, nothing to clean up.');
    return;
  }

  logger.debug('Application cleanup started...');

  try {
    performanceMonitor.mark('app-cleanup-start');

    // Stop analytics tracking and send final session summary
    stopPeriodicSessionTracking();
    logger.debug('Analytics tracking stopped.');

    // Cleanup in reverse order of initialization
    await cleanupPluginSystem();
    logger.debug('Plugin system cleaned up.');

    // Cleanup core services
    contextBridge.cleanup();
    circuitBreaker.cleanup();
    performanceMonitor.cleanup();
    globalErrorHandler.cleanup();
    logger.debug('Core services cleaned up.');

    // Cleanup event handlers
    cleanupGlobalEventHandlers();
    logger.debug('Global event handlers cleaned up.');

    // Clean up stores if they have cleanup methods
    // Note: Zustand stores typically don't need explicit cleanup

    performanceMonitor.mark('app-cleanup-complete');

    isInitialized = false;
    isApplicationStateInitialized = false;
    logger.debug('Application cleanup completed.');

    eventBus.emit('app:shutdown', {
      reason: 'Application cleanup initiated',
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('Error during application cleanup:', error);
    globalErrorHandler.handleError(
      error instanceof Error ? error : new Error(String(error)),
      {
        component: 'main-initializer',
        operation: 'application-cleanup',
      },
      'high',
    );
  }
}

/**
 * Get initialization status
 */
export function getInitializationStatus(): {
  isInitialized: boolean;
  initializationTime?: number;
  errorCount: number;
  performanceStats: any;
} {
  return {
    isInitialized,
    initializationTime: isInitialized ? performance.now() - initializationStartTime : undefined,
    errorCount: globalErrorHandler.getErrorStats().totalErrors,
    performanceStats: performanceMonitor.getStats(),
  };
}

/**
 * Force re-initialization (for development/testing)
 */
export async function forceReinitialization(): Promise<void> {
  logger.warn('Force re-initialization requested...');

  if (isInitialized) {
    await applicationCleanup();
  }

  // Reset the flag
  isInitialized = false;

  // Re-initialize
  await applicationInit();
}

// Handle script unload or extension disable for cleanup (if applicable)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    applicationCleanup().catch(err => {
      logger.error('Error during beforeunload cleanup:', err);
    });
  });
}

// Handle Chrome extension suspension (for background scripts)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    applicationCleanup().catch(err => {
      logger.error('Error during extension suspend cleanup:', err);
    });
  });
}

// Export initialization status and utilities for debugging
export const initializationUtils = {
  getStatus: getInitializationStatus,
  forceReinit: forceReinitialization,
  isInitialized: () => isInitialized,
};
