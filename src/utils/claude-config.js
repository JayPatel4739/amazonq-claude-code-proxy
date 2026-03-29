/**
 * Claude Config Helper
 * Read/write ~/.claude/settings.json for auto-configuration.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Read current Claude Code settings
 */
export function readClaudeConfig() {
    try {
        if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
            return { exists: false, settings: null, path: CLAUDE_SETTINGS_PATH };
        }
        const content = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
        return { exists: true, settings: content, path: CLAUDE_SETTINGS_PATH };
    } catch (error) {
        return { exists: false, settings: null, path: CLAUDE_SETTINGS_PATH, error: error.message };
    }
}

/**
 * Check if Claude Code is configured to use this proxy
 */
export function isConfiguredForProxy(port) {
    const { settings } = readClaudeConfig();
    if (!settings) return false;

    const baseUrl = settings.env?.ANTHROPIC_BASE_URL || '';
    return baseUrl.includes(`localhost:${port}`) || baseUrl.includes(`127.0.0.1:${port}`);
}

/**
 * Apply proxy configuration to Claude Code settings
 */
export function applyProxyConfig(port, apiKey = 'amazonq') {
    const { exists, settings } = readClaudeConfig();

    const config = settings || {};
    if (!config.env) config.env = {};

    config.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
    config.env.ANTHROPIC_API_KEY = apiKey;

    try {
        const dir = path.dirname(CLAUDE_SETTINGS_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(config, null, 2));
        logger.success(`[ClaudeConfig] Applied proxy config to ${CLAUDE_SETTINGS_PATH}`);
        return { success: true, path: CLAUDE_SETTINGS_PATH };
    } catch (error) {
        logger.error(`[ClaudeConfig] Failed to write settings: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Remove proxy configuration from Claude Code settings
 */
export function removeProxyConfig() {
    const { exists, settings } = readClaudeConfig();
    if (!settings || !settings.env) return { success: true };

    delete settings.env.ANTHROPIC_BASE_URL;
    delete settings.env.ANTHROPIC_API_KEY;

    if (Object.keys(settings.env).length === 0) {
        delete settings.env;
    }

    try {
        fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
