/**
 * Amazon Q Claude Proxy
 * Entry point - starts the proxy server
 */

import app, { accountManager } from './server.js';
import { logger } from './utils/logger.js';
import { DEFAULT_PORT, SELECTION_STRATEGIES } from './constants.js';
import { getStrategyLabel } from './account-manager/strategies/index.js';

const PORT = process.env.PORT || DEFAULT_PORT;
const HOST = process.env.HOST || '0.0.0.0';

// Parse CLI flags
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';

// Parse --strategy flag
let strategyOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        strategyOverride = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        strategyOverride = args[i + 1];
    }
}

if (strategyOverride && !SELECTION_STRATEGIES.includes(strategyOverride.toLowerCase())) {
    logger.warn(`[Startup] Invalid strategy "${strategyOverride}". Valid: ${SELECTION_STRATEGIES.join(', ')}`);
    strategyOverride = null;
}

if (isDebug) {
    logger.setDebug(true);
    logger.debug('Debug mode enabled');
}

// Start server
async function main() {
    // Initialize account manager
    try {
        await accountManager.initialize(strategyOverride);
    } catch (err) {
        logger.warn(`[Startup] Account manager init: ${err.message}`);
        logger.log('');
        logger.log('  No accounts configured yet. Visit the dashboard to add accounts.');
        logger.log('');
    }

    const status = accountManager.getStatus();
    const strategyLabel = accountManager.getStrategyLabel();

    const server = app.listen(PORT, HOST, () => {
        console.clear();
        logger.log(`
╔══════════════════════════════════════════════════════════════╗
║            Amazon Q Claude Proxy Server v1.0.0              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Server & WebUI: http://localhost:${PORT}                        ║
║                                                              ║
║  Accounts: ${String(status.total).padEnd(3)} total, ${String(status.available).padEnd(3)} available                     ║
║  Strategy: ${strategyLabel.padEnd(48)}║
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages         - Anthropic Messages API        ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║                                                              ║
║  Usage with Claude Code:                                     ║
║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}             ║
║    export ANTHROPIC_API_KEY=amazonq                          ║
║    claude                                                    ║
║                                                              ║
║  Add accounts:                                               ║
║    Visit http://localhost:${PORT} or run: npm run accounts       ║
║                                                              ║
║  Control:                                                    ║
║    --strategy=<s>     sticky / round-robin / hybrid          ║
║    --debug            Enable verbose logging                 ║
║    Ctrl+C             Stop server                            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
        logger.success(`Server started on port ${PORT}`);
        if (isDebug) {
            logger.warn('Running in DEBUG mode - verbose logs enabled');
        }
    });

    // Graceful shutdown
    const shutdown = () => {
        logger.info('Shutting down...');
        server.close(() => {
            logger.success('Server stopped');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch(err => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
