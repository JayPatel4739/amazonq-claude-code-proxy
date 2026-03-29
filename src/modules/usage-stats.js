/**
 * Usage Stats Module
 * Tracks requests per model per hour, persisted to disk, with 30-day pruning.
 */

import fs from 'fs';
import path from 'path';
import { USAGE_HISTORY_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

const HISTORY_FILE = USAGE_HISTORY_PATH;
const DATA_DIR = path.dirname(HISTORY_FILE);

let history = {};
let isDirty = false;

function getFamily(modelId) {
    const lower = (modelId || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    return 'other';
}

function getShortName(modelId, family) {
    if (family === 'other') return modelId;
    return modelId.replace(new RegExp(`^${family}-`, 'i'), '');
}

function load() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
        }
    } catch (err) {
        logger.error('[UsageStats] Failed to load history:', err);
        history = {};
    }
}

function save() {
    if (!isDirty) return;
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[UsageStats] Failed to save history:', err);
    }
}

function prune() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let pruned = false;

    for (const key of Object.keys(history)) {
        if (new Date(key) < cutoff) {
            delete history[key];
            pruned = true;
        }
    }

    if (pruned) isDirty = true;
}

function track(modelId, accountLabel = null) {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const key = now.toISOString();

    if (!history[key]) {
        history[key] = { _total: 0 };
    }

    const hourData = history[key];
    const family = getFamily(modelId);
    const shortName = getShortName(modelId, family);

    if (!hourData[family]) {
        hourData[family] = { _subtotal: 0 };
    }

    hourData[family][shortName] = (hourData[family][shortName] || 0) + 1;
    hourData[family]._subtotal = (hourData[family]._subtotal || 0) + 1;
    hourData._total = (hourData._total || 0) + 1;

    // Per-account tracking
    if (accountLabel) {
        if (!hourData.accounts) hourData.accounts = {};
        hourData.accounts[accountLabel] = (hourData.accounts[accountLabel] || 0) + 1;
    }

    isDirty = true;
}

function setupMiddleware(app) {
    load();

    setInterval(() => {
        save();
        prune();
    }, 60 * 1000);

    process.on('SIGINT', () => { save(); process.exit(); });
    process.on('SIGTERM', () => { save(); process.exit(); });

    app.use((req, res, next) => {
        if (req.method === 'POST' && req.path === '/v1/messages') {
            const model = req.body?.model;
            if (model) {
                track(model);
            }
        }
        next();
    });
}

function setupRoutes(app) {
    app.get('/api/stats/history', (req, res) => {
        const sortedKeys = Object.keys(history).sort();
        const sortedData = {};
        sortedKeys.forEach(key => { sortedData[key] = history[key]; });
        res.json(sortedData);
    });
}

function getHistory() {
    const sortedKeys = Object.keys(history).sort();
    const sortedData = {};
    sortedKeys.forEach(key => { sortedData[key] = history[key]; });
    return sortedData;
}

function getTotalRequests() {
    let total = 0;
    for (const hourData of Object.values(history)) {
        total += hourData._total || 0;
    }
    return total;
}

export default {
    setupMiddleware,
    setupRoutes,
    track,
    getHistory,
    getTotalRequests,
    getFamily,
    getShortName
};
