/**
 * Account Storage
 * Handles loading and saving account configuration to disk.
 * Stores config at ~/.amazonq-claude-proxy/accounts.json
 */

import { readFile, writeFile, mkdir, access, rename } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

let writeLock = null;

/**
 * Load accounts from the config file
 */
export async function loadAccounts(configPath = ACCOUNT_CONFIG_PATH) {
    try {
        await access(configPath, fsConstants.F_OK);
        const configData = await readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);

        const accounts = (config.accounts || []).map(acc => ({
            ...acc,
            lastUsed: acc.lastUsed || null,
            enabled: acc.enabled !== false,
            // Reset invalid flag on startup except accounts needing re-auth
            isInvalid: acc.needsReauth ? (acc.isInvalid || false) : false,
            invalidReason: acc.needsReauth ? (acc.invalidReason || null) : null,
            needsReauth: acc.needsReauth || false,
            modelRateLimits: acc.modelRateLimits || {}
        }));

        const clientRegistration = config.clientRegistration || null;
        const settings = config.settings || {};
        let activeIndex = config.activeIndex || 0;

        if (activeIndex >= accounts.length) {
            activeIndex = 0;
        }

        logger.info(`[Storage] Loaded ${accounts.length} account(s) from config`);

        return { accounts, clientRegistration, settings, activeIndex };
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Storage] No config file found, starting fresh');
        } else {
            logger.error('[Storage] Failed to load config:', error.message);
        }
        return { accounts: [], clientRegistration: null, settings: {}, activeIndex: 0 };
    }
}

/**
 * Save account configuration to disk (atomic write)
 */
export async function saveAccounts(configPath, accounts, clientRegistration, settings, activeIndex) {
    const previousLock = writeLock;
    let resolve;
    writeLock = new Promise(r => { resolve = r; });

    try {
        if (previousLock) await previousLock;
    } catch {
        // Previous write failed, proceed anyway
    }

    try {
        const dir = dirname(configPath);
        await mkdir(dir, { recursive: true });

        const config = {
            accounts: accounts.map(acc => ({
                id: acc.id,
                label: acc.label,
                startUrl: acc.startUrl,
                region: acc.region,
                refreshToken: acc.refreshToken,
                profileArn: acc.profileArn || null,
                enabled: acc.enabled !== false,
                addedAt: acc.addedAt || undefined,
                isInvalid: acc.isInvalid || false,
                invalidReason: acc.invalidReason || null,
                needsReauth: acc.needsReauth || false,
                modelRateLimits: acc.modelRateLimits || {},
                lastUsed: acc.lastUsed
            })),
            clientRegistration: clientRegistration || null,
            settings,
            activeIndex
        };

        const json = JSON.stringify(config, null, 2);

        // Validate JSON before writing
        JSON.parse(json);

        // Atomic write: temp file then rename
        const tmpPath = configPath + '.tmp';
        await writeFile(tmpPath, json);
        await rename(tmpPath, configPath);
    } catch (error) {
        logger.error('[Storage] Failed to save config:', error.message);
    } finally {
        resolve();
    }
}
