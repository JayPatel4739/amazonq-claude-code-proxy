/**
 * WebUI - Mount static files and dashboard API routes
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import usageStats from '../modules/usage-stats.js';
import requestLogger from '../modules/request-logger.js';
import { readClaudeConfig, applyProxyConfig, removeProxyConfig, isConfiguredForProxy } from '../utils/claude-config.js';
import { AVAILABLE_MODELS, DEFAULT_PORT, SELECTION_STRATEGIES, STRATEGY_LABELS } from '../constants.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const startTime = Date.now();

/**
 * Mount WebUI routes on the Express app
 */
export function mountWebUI(app, accountManager) {
    // Serve static files from public/
    const publicDir = path.join(__dirname, '..', '..', 'public');
    app.use(express.static(publicDir));

    // ============ API Routes ============

    // Server status
    app.get('/api/status', async (req, res) => {
        const port = req.socket.localPort || DEFAULT_PORT;
        const status = accountManager.getStatus();
        res.json({
            uptime: Date.now() - startTime,
            uptimeFormatted: formatDuration(Date.now() - startTime),
            totalRequests: usageStats.getTotalRequests(),
            logCount: requestLogger.size,
            port,
            strategy: status.strategy,
            strategyLabel: STRATEGY_LABELS[status.strategy] || status.strategy,
            claudeConfigured: isConfiguredForProxy(port),
            accounts: status
        });
    });

    // List accounts (sanitized)
    app.get('/api/accounts', (req, res) => {
        const status = accountManager.getStatus();
        res.json(status.accounts);
    });

    // Start add-account flow
    app.post('/api/accounts', async (req, res) => {
        try {
            const { startUrl, region } = req.body || {};
            const result = await accountManager.startAddAccount(
                startUrl || 'https://view.awsapps.com/start',
                region || 'us-east-1'
            );
            res.json(result);
        } catch (error) {
            logger.error('[WebUI] Add account error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Poll for device auth completion
    app.get('/api/accounts/:id/poll', async (req, res) => {
        try {
            const account = await accountManager.pollAddAccount(req.params.id);
            if (account) {
                res.json({ status: 'completed', account: sanitizeAccount(account) });
            } else {
                res.json({ status: 'pending' });
            }
        } catch (error) {
            res.status(400).json({ status: 'error', error: error.message });
        }
    });

    // Remove account
    app.delete('/api/accounts/:id', (req, res) => {
        const removed = accountManager.removeAccount(req.params.id);
        if (removed) {
            res.json({ status: 'ok' });
        } else {
            res.status(404).json({ error: 'Account not found' });
        }
    });

    // Update account
    app.patch('/api/accounts/:id', (req, res) => {
        const { label, enabled } = req.body || {};
        const updated = accountManager.updateAccount(req.params.id, { label, enabled });
        if (updated) {
            res.json(sanitizeAccount(updated));
        } else {
            res.status(404).json({ error: 'Account not found' });
        }
    });

    // Force refresh token for account
    app.post('/api/accounts/:id/refresh', async (req, res) => {
        try {
            const accounts = accountManager.getAllAccounts();
            const account = accounts.find(a => a.id === req.params.id);
            if (!account) {
                return res.status(404).json({ error: 'Account not found' });
            }
            const token = await accountManager.getTokenForAccount(account);
            res.json({ status: 'ok', tokenPrefix: token.substring(0, 10) + '...' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Re-auth account (start new device flow for invalid account)
    app.post('/api/accounts/:id/reauth', async (req, res) => {
        try {
            const accounts = accountManager.getAllAccounts();
            const account = accounts.find(a => a.id === req.params.id);
            if (!account) {
                return res.status(404).json({ error: 'Account not found' });
            }

            const result = await accountManager.startAddAccount(
                account.startUrl || 'https://view.awsapps.com/start',
                account.region || 'us-east-1'
            );

            // Store the target account id for update on completion
            result.targetAccountId = account.id;
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Strategy
    app.get('/api/strategy', (req, res) => {
        res.json({
            current: accountManager.getStrategyName(),
            label: accountManager.getStrategyLabel(),
            available: SELECTION_STRATEGIES.map(s => ({
                name: s,
                label: STRATEGY_LABELS[s] || s
            }))
        });
    });

    app.put('/api/strategy', (req, res) => {
        try {
            const { strategy } = req.body;
            accountManager.setStrategy(strategy);
            res.json({
                status: 'ok',
                current: accountManager.getStrategyName(),
                label: accountManager.getStrategyLabel()
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Usage stats
    usageStats.setupRoutes(app);

    // Request logs
    app.get('/api/logs', (req, res) => {
        const { model, account, status, limit } = req.query;
        const logs = requestLogger.query({
            model,
            account,
            status,
            limit: parseInt(limit, 10) || 100
        });
        res.json(logs);
    });

    // Models
    app.get('/api/models', (req, res) => {
        res.json(AVAILABLE_MODELS);
    });

    // Claude config
    app.get('/api/claude-config', (req, res) => {
        const config = readClaudeConfig();
        const port = req.socket.localPort || DEFAULT_PORT;
        res.json({
            ...config,
            isConfigured: isConfiguredForProxy(port),
            proxyPort: port
        });
    });

    app.post('/api/claude-config', (req, res) => {
        const { action } = req.body;
        const port = req.socket.localPort || DEFAULT_PORT;

        if (action === 'apply') {
            const result = applyProxyConfig(port);
            res.json(result);
        } else if (action === 'remove') {
            const result = removeProxyConfig();
            res.json(result);
        } else {
            res.status(400).json({ error: 'Invalid action. Use "apply" or "remove".' });
        }
    });
}

function sanitizeAccount(account) {
    return {
        id: account.id,
        label: account.label,
        startUrl: account.startUrl,
        region: account.region,
        enabled: account.enabled !== false,
        isInvalid: account.isInvalid || false,
        invalidReason: account.invalidReason || null,
        needsReauth: account.needsReauth || false,
        lastUsed: account.lastUsed,
        addedAt: account.addedAt,
        modelRateLimits: account.modelRateLimits || {}
    };
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
