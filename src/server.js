/**
 * Express Server - Anthropic-compatible API
 * Proxies to Amazon Q via CodeWhisperer streaming API
 * Supports multi-account load balancing
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { sendChatMessage, collectChatResponse } from './amazonq/chat-api.js';
import { convertAnthropicToQ } from './format/request-converter.js';
import {
    convertQToAnthropic,
    createMessageStart,
    createContentBlockStart,
    createContentBlockDelta,
    createContentBlockStop,
    createMessageDelta,
    createMessageStop
} from './format/response-converter.js';
import { AccountManager } from './account-manager/index.js';
import { mountWebUI } from './webui/index.js';
import usageStats from './modules/usage-stats.js';
import requestLogger from './modules/request-logger.js';
import { logger } from './utils/logger.js';
import { REQUEST_BODY_LIMIT, AVAILABLE_MODELS } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse --strategy flag
const args = process.argv.slice(2);
let STRATEGY_OVERRIDE = null;
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--strategy=')) {
        STRATEGY_OVERRIDE = args[i].split('=')[1];
    } else if (args[i] === '--strategy' && args[i + 1]) {
        STRATEGY_OVERRIDE = args[i + 1];
    }
}

const app = express();
app.disable('x-powered-by');

// Initialize account manager
export const accountManager = new AccountManager();

let isInitialized = false;
let initPromise = null;

async function ensureInitialized() {
    if (isInitialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            await accountManager.initialize(STRATEGY_OVERRIDE);
            isInitialized = true;
            const status = accountManager.getStatus();
            logger.success(`[Server] Account pool initialized: ${status.summary}`);
        } catch (error) {
            initPromise = null;
            logger.error('[Server] Failed to initialize account manager:', error.message);
            throw error;
        }
    })();

    return initPromise;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Usage stats middleware
usageStats.setupMiddleware(app);

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const logMsg = `[${req.method}] ${req.originalUrl} ${res.statusCode} (${duration}ms)`;
        if (res.statusCode >= 500) logger.error(logMsg);
        else if (res.statusCode >= 400) logger.warn(logMsg);
        else if (!req.originalUrl.includes('event_logging') && !req.originalUrl.startsWith('/api/')) logger.info(logMsg);
    });
    next();
});

// Mount WebUI (static files + API routes)
mountWebUI(app, accountManager);

// Silent handler for Claude Code heartbeats
app.post('/', (req, res) => res.status(200).json({ status: 'ok' }));
app.post('/api/event_logging/batch', (req, res) => res.status(200).json({ status: 'ok' }));

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        await ensureInitialized();
        const status = accountManager.getStatus();
        res.json({
            status: status.total > 0 ? 'ok' : 'no_accounts',
            timestamp: new Date().toISOString(),
            accounts: status
        });
    } catch (error) {
        res.json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

/**
 * Force token refresh (legacy endpoint)
 */
app.post('/refresh-token', async (req, res) => {
    try {
        await ensureInitialized();
        const { account } = accountManager.selectAccount();
        if (!account) {
            return res.status(400).json({ status: 'error', error: 'No accounts available' });
        }
        const token = await accountManager.getTokenForAccount(account);
        res.json({
            status: 'ok',
            message: 'Token refreshed',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

/**
 * List models endpoint (Anthropic-compatible)
 */
app.get('/v1/models', (req, res) => {
    res.json({
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: Date.now(),
            owned_by: 'anthropic'
        })),
        object: 'list'
    });
});

/**
 * Count tokens endpoint - approximation (~4 chars/token)
 */
app.post('/v1/messages/count_tokens', (req, res) => {
    const text = JSON.stringify(req.body);
    const inputTokens = Math.ceil(text.length / 4);
    res.json({ input_tokens: inputTokens });
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */
app.post('/v1/messages', async (req, res) => {
    const requestStart = Date.now();
    let selectedAccount = null;

    try {
        await ensureInitialized();

        const { model, messages, stream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        const requestedModel = model || 'claude-sonnet-4-6';
        logger.info(`[API] Request for model: ${requestedModel}, stream: ${!!stream}, messages: ${messages.length}`);

        // Select account
        const { account, waitMs } = accountManager.selectAccount(requestedModel);

        if (!account) {
            if (accountManager.isAllRateLimited(requestedModel)) {
                const retryAfter = Math.ceil(accountManager.getMinWaitTimeMs(requestedModel) / 1000);
                res.setHeader('Retry-After', String(retryAfter));
                return res.status(429).json({
                    type: 'error',
                    error: {
                        type: 'rate_limit_error',
                        message: `All accounts are rate-limited. Retry in ${retryAfter}s.`
                    }
                });
            }

            if (accountManager.getAccountCount() === 0) {
                return res.status(401).json({
                    type: 'error',
                    error: {
                        type: 'authentication_error',
                        message: 'No accounts configured. Visit the dashboard to add an account.'
                    }
                });
            }

            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: 'No available accounts. Check the dashboard for details.'
                }
            });
        }

        selectedAccount = account;
        logger.debug(`[API] Using account: ${account.label || account.id}`);

        // Get token for selected account
        let token;
        try {
            token = await accountManager.getTokenForAccount(account);
        } catch (authError) {
            accountManager.markInvalid(account.id, authError.message);
            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: `Auth failed for account ${account.label}: ${authError.message}`
                }
            });
        }

        // Convert Anthropic request to Q format
        const conversationState = convertAnthropicToQ(req.body);

        if (stream) {
            try {
                let fullText = '';
                let firstEventReceived = false;

                const generator = sendChatMessage(conversationState, token, account.profileArn);

                for await (const event of generator) {
                    if (!firstEventReceived) {
                        firstEventReceived = true;
                        res.status(200);
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                        res.setHeader('X-Accel-Buffering', 'no');
                        res.flushHeaders();

                        const msgStart = createMessageStart(requestedModel);
                        res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);
                        const blockStart = createContentBlockStart(0);
                        res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                        if (res.flush) res.flush();
                    }

                    if (event.eventType === 'assistantResponseEvent') {
                        const content = event.data?.content ||
                            event.data?.assistantResponseEvent?.content || '';
                        if (content) {
                            fullText += content;
                            const delta = createContentBlockDelta(0, content);
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`);
                            if (res.flush) res.flush();
                        }
                    }
                }

                if (!firstEventReceived) {
                    res.status(200);
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.flushHeaders();

                    const msgStart = createMessageStart(requestedModel);
                    res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);
                    const blockStart = createContentBlockStart(0);
                    res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                }

                // Parse tool_use blocks
                const hasToolUse = fullText.includes('<tool_use');
                res.write(`event: content_block_stop\ndata: ${JSON.stringify(createContentBlockStop(0))}\n\n`);

                if (hasToolUse) {
                    const toolUseRegex = /<tool_use\s+id="([^"]*?)"\s+name="([^"]*?)">\s*([\s\S]*?)\s*<\/tool_use>/g;
                    let match;
                    let blockIndex = 1;

                    while ((match = toolUseRegex.exec(fullText)) !== null) {
                        const toolId = match[1] || `toolu_${crypto.randomBytes(12).toString('hex')}`;
                        const toolName = match[2];
                        let toolInput = {};
                        try {
                            let parsed = JSON.parse(match[3].trim());
                            // Handle double-encoded JSON (string instead of object)
                            while (typeof parsed === 'string') {
                                try { parsed = JSON.parse(parsed); } catch { break; }
                            }
                            toolInput = typeof parsed === 'object' && parsed !== null ? parsed : { text: String(parsed) };
                        } catch {
                            const raw = match[3].trim();
                            try {
                                const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
                                toolInput = JSON.parse(cleaned);
                            } catch {
                                toolInput = { text: raw };
                            }
                        }

                        const toolStart = createContentBlockStart(blockIndex, 'tool_use', {
                            id: toolId,
                            name: toolName
                        });
                        res.write(`event: content_block_start\ndata: ${JSON.stringify(toolStart)}\n\n`);

                        const inputDelta = createContentBlockDelta(
                            blockIndex,
                            JSON.stringify(toolInput),
                            'input_json_delta'
                        );
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`);
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify(createContentBlockStop(blockIndex))}\n\n`);

                        blockIndex++;
                    }
                }

                const outputTokens = Math.ceil(fullText.length / 4);
                const stopReason = hasToolUse ? 'tool_use' : 'end_turn';

                res.write(`event: message_delta\ndata: ${JSON.stringify(createMessageDelta(stopReason, outputTokens))}\n\n`);
                res.write(`event: message_stop\ndata: ${JSON.stringify(createMessageStop())}\n\n`);
                res.end();

                // Notify success
                accountManager.notifySuccess(account, requestedModel);

                // Log request
                requestLogger.log({
                    model: requestedModel,
                    account: account.label || account.id,
                    status: 200,
                    duration: Date.now() - requestStart,
                    stream: true,
                    outputTokens
                });

            } catch (error) {
                handleStreamError(error, res, account, requestedModel, requestStart);
            }

        } else {
            // Non-streaming response
            const { content } = await collectChatResponse(conversationState, token, account.profileArn);
            const response = convertQToAnthropic(content, requestedModel);
            res.json(response);

            accountManager.notifySuccess(account, requestedModel);

            requestLogger.log({
                model: requestedModel,
                account: account.label || account.id,
                status: 200,
                duration: Date.now() - requestStart,
                stream: false,
                outputTokens: response.usage.output_tokens
            });
        }

    } catch (error) {
        logger.error('[API] Error:', error);
        const { statusCode, errorType, errorMessage } = parseError(error);

        // Handle rate limiting
        if (selectedAccount && statusCode === 429) {
            accountManager.markRateLimited(selectedAccount.id, 60000, req.body?.model);
            accountManager.notifyRateLimit(selectedAccount, req.body?.model);
        } else if (selectedAccount && statusCode === 401) {
            accountManager.markInvalid(selectedAccount.id, errorMessage);
        } else if (selectedAccount) {
            accountManager.notifyFailure(selectedAccount, req.body?.model);
        }

        requestLogger.log({
            model: req.body?.model || 'unknown',
            account: selectedAccount?.label || 'none',
            status: statusCode,
            duration: Date.now() - requestStart,
            stream: !!req.body?.stream,
            error: errorMessage
        });

        if (res.headersSent) {
            res.write(`event: error\ndata: ${JSON.stringify({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            })}\n\n`);
            res.end();
        } else {
            res.status(statusCode).json({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            });
        }
    }
});

function handleStreamError(error, res, account, model, requestStart) {
    const { statusCode, errorType, errorMessage } = parseError(error);

    if (statusCode === 429 && account) {
        accountManager.markRateLimited(account.id, 60000, model);
        accountManager.notifyRateLimit(account, model);
    } else if (statusCode === 401 && account) {
        accountManager.markInvalid(account.id, errorMessage);
    } else if (account) {
        accountManager.notifyFailure(account, model);
    }

    requestLogger.log({
        model: model || 'unknown',
        account: account?.label || 'none',
        status: statusCode,
        duration: Date.now() - requestStart,
        stream: true,
        error: errorMessage
    });

    if (!res.headersSent) {
        res.status(statusCode).json({
            type: 'error',
            error: { type: errorType, message: errorMessage }
        });
        return;
    }

    logger.error('[API] Mid-stream error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: errorType, message: errorMessage }
    })}\n\n`);
    res.end();
}

function parseError(error) {
    const msg = error.message || '';
    if (msg.includes('AUTH_ERROR') || msg.includes('401') || msg.includes('403')) {
        return { statusCode: 401, errorType: 'authentication_error', errorMessage: msg };
    }
    if (msg.includes('RATE_LIMITED') || msg.includes('429')) {
        return { statusCode: 429, errorType: 'rate_limit_error', errorMessage: msg };
    }
    if (msg.includes('invalid_request')) {
        return { statusCode: 400, errorType: 'invalid_request_error', errorMessage: msg };
    }
    return { statusCode: 500, errorType: 'api_error', errorMessage: msg };
}

/**
 * Catch-all for unsupported endpoints
 */
app.use('*', (req, res) => {
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;
