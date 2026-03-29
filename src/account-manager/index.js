/**
 * Account Manager
 * Manages multiple AWS SSO accounts with configurable selection strategies,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import crypto from 'crypto';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { loadAccounts, saveAccounts } from './storage.js';
import { getTokenForAccount, clearTokenCache } from './credentials.js';
import {
    markRateLimited as markLimited,
    markInvalid as markAccountInvalid,
    clearInvalid as clearAccountInvalid,
    clearExpiredLimits as clearLimits,
    resetAllRateLimits as resetLimits,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    isAllRateLimited as checkAllRateLimited,
    getMinWaitTimeMs as getMinWait,
    getRateLimitInfo as getLimitInfo,
    getConsecutiveFailures as getFailures,
    resetConsecutiveFailures as resetFailures,
    incrementConsecutiveFailures as incrementFailures,
    markAccountCoolingDown as markCoolingDown,
    isAccountCoolingDown as checkCoolingDown,
    clearAccountCooldown as clearCooldown,
    getCooldownRemaining as getCooldownMs,
    CooldownReason
} from './rate-limits.js';
import { createStrategy, getStrategyLabel, DEFAULT_STRATEGY, STRATEGY_NAMES } from './strategies/index.js';
import { initiateDeviceAuthFlow, pollForToken, openBrowser } from '../auth/sso-oauth.js';
import { logger } from '../utils/logger.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #clientRegistration = null;
    #initialized = false;
    #strategy = null;
    #strategyName = DEFAULT_STRATEGY;
    #tokenCache = new Map();

    // Track pending device auth flows (for WebUI polling)
    #pendingAuthFlows = new Map();

    constructor(configPath = ACCOUNT_CONFIG_PATH) {
        this.#configPath = configPath;
    }

    async initialize(strategyOverride = null) {
        if (this.#initialized) return;

        const { accounts, clientRegistration, settings, activeIndex } = await loadAccounts(this.#configPath);

        this.#accounts = accounts;
        this.#clientRegistration = clientRegistration;
        this.#settings = settings;
        this.#currentIndex = activeIndex;

        // Determine strategy
        const envStrategy = process.env.ACCOUNT_STRATEGY;
        const configStrategy = settings.strategy;
        this.#strategyName = strategyOverride || envStrategy || configStrategy || this.#strategyName;

        this.#strategy = createStrategy(this.#strategyName, settings);
        logger.info(`[AccountManager] Using ${getStrategyLabel(this.#strategyName)} strategy`);

        this.clearExpiredLimits();
        this.#initialized = true;
    }

    async reload() {
        this.#initialized = false;
        await this.initialize();
        logger.info('[AccountManager] Accounts reloaded from disk');
    }

    // ========== Account Selection ==========

    selectAccount(modelId = null) {
        if (!this.#strategy) {
            throw new Error('AccountManager not initialized');
        }

        const result = this.#strategy.selectAccount(this.#accounts, modelId, {
            currentIndex: this.#currentIndex,
            onSave: () => this.saveToDisk()
        });

        this.#currentIndex = result.index;
        return { account: result.account, waitMs: result.waitMs || 0 };
    }

    notifySuccess(account, modelId) {
        if (this.#strategy) this.#strategy.onSuccess(account, modelId);
        if (account?.id) resetFailures(this.#accounts, account.id);
        account.lastUsed = new Date().toISOString();
    }

    notifyRateLimit(account, modelId) {
        if (this.#strategy) this.#strategy.onRateLimit(account, modelId);
    }

    notifyFailure(account, modelId) {
        if (this.#strategy) this.#strategy.onFailure(account, modelId);
    }

    // ========== Token Management ==========

    async getTokenForAccount(account) {
        return getTokenForAccount(
            account,
            this.#clientRegistration,
            this.#tokenCache,
            (id, reason) => this.markInvalid(id, reason),
            () => this.saveToDisk()
        );
    }

    // ========== Account CRUD ==========

    getAccountCount() { return this.#accounts.length; }
    getAllAccounts() { return this.#accounts; }
    getClientRegistration() { return this.#clientRegistration; }

    /**
     * Start adding a new account (device auth flow)
     * Returns device auth info for the user to complete in browser
     */
    async startAddAccount(startUrl, region = 'us-east-1') {
        const { clientRegistration, deviceAuth } = await initiateDeviceAuthFlow(
            this.#clientRegistration,
            startUrl,
            region
        );

        // Update client registration if it was created/renewed
        this.#clientRegistration = clientRegistration;
        await this.saveToDisk();

        // Store pending flow for polling
        const flowId = crypto.randomUUID();
        this.#pendingAuthFlows.set(flowId, {
            deviceAuth,
            clientRegistration,
            startUrl,
            region,
            startedAt: Date.now()
        });

        return {
            flowId,
            userCode: deviceAuth.userCode,
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            expiresIn: deviceAuth.expiresIn,
            interval: deviceAuth.interval
        };
    }

    /**
     * Poll for device auth completion
     */
    async pollAddAccount(flowId) {
        const flow = this.#pendingAuthFlows.get(flowId);
        if (!flow) throw new Error('Auth flow not found or expired');

        try {
            const tokens = await pollForToken(
                flow.clientRegistration.clientId,
                flow.clientRegistration.clientSecret,
                flow.deviceAuth.deviceCode,
                flow.deviceAuth.interval,
                flow.deviceAuth.expiresIn,
                flow.region
            );

            // Create account
            const account = {
                id: crypto.randomUUID(),
                label: `Account ${this.#accounts.length + 1}`,
                startUrl: flow.startUrl,
                region: flow.region,
                refreshToken: tokens.refreshToken,
                profileArn: null,
                enabled: true,
                addedAt: new Date().toISOString(),
                lastUsed: null,
                modelRateLimits: {},
                isInvalid: false,
                invalidReason: null,
                needsReauth: false
            };

            this.#accounts.push(account);
            this.#pendingAuthFlows.delete(flowId);
            await this.saveToDisk();

            logger.success(`[AccountManager] Account added: ${account.label}`);
            return account;
        } catch (error) {
            if (error.message.includes('authorization_pending')) {
                return null; // Still waiting
            }
            this.#pendingAuthFlows.delete(flowId);
            throw error;
        }
    }

    /**
     * Complete add-account flow synchronously (for CLI)
     */
    async addAccountSync(startUrl, region = 'us-east-1') {
        const { clientRegistration, deviceAuth } = await initiateDeviceAuthFlow(
            this.#clientRegistration,
            startUrl,
            region
        );

        this.#clientRegistration = clientRegistration;

        // Open browser
        await openBrowser(deviceAuth.verificationUriComplete);

        // Poll until completion
        const tokens = await pollForToken(
            clientRegistration.clientId,
            clientRegistration.clientSecret,
            deviceAuth.deviceCode,
            deviceAuth.interval,
            deviceAuth.expiresIn,
            region
        );

        const account = {
            id: crypto.randomUUID(),
            label: `Account ${this.#accounts.length + 1}`,
            startUrl,
            region,
            refreshToken: tokens.refreshToken,
            profileArn: null,
            enabled: true,
            addedAt: new Date().toISOString(),
            lastUsed: null,
            modelRateLimits: {},
            isInvalid: false,
            invalidReason: null,
            needsReauth: false
        };

        this.#accounts.push(account);
        await this.saveToDisk();

        logger.success(`[AccountManager] Account added: ${account.label}`);
        return account;
    }

    removeAccount(accountId) {
        const index = this.#accounts.findIndex(a => a.id === accountId);
        if (index === -1) return false;

        this.#accounts.splice(index, 1);
        this.#tokenCache.delete(accountId);

        if (this.#currentIndex >= this.#accounts.length) {
            this.#currentIndex = 0;
        }

        this.saveToDisk();
        return true;
    }

    updateAccount(accountId, updates) {
        const account = this.#accounts.find(a => a.id === accountId);
        if (!account) return null;

        if (updates.label !== undefined) account.label = updates.label;
        if (updates.enabled !== undefined) account.enabled = updates.enabled;

        this.saveToDisk();
        return account;
    }

    // ========== Rate Limits ==========

    markRateLimited(accountId, resetMs = null, modelId = null) {
        markLimited(this.#accounts, accountId, resetMs, modelId);
        this.saveToDisk();
    }

    markInvalid(accountId, reason = 'Unknown error') {
        markAccountInvalid(this.#accounts, accountId, reason);
        this.saveToDisk();
    }

    clearInvalid(accountId) {
        clearAccountInvalid(this.#accounts, accountId);
        this.saveToDisk();
    }

    clearExpiredLimits() {
        const cleared = clearLimits(this.#accounts);
        if (cleared > 0) this.saveToDisk();
        return cleared;
    }

    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    // ========== Strategy ==========

    getStrategyName() { return this.#strategyName; }

    getStrategyLabel() {
        return getStrategyLabel(this.#strategyName);
    }

    setStrategy(name) {
        if (!STRATEGY_NAMES.includes(name.toLowerCase()) && name.toLowerCase() !== 'roundrobin') {
            throw new Error(`Invalid strategy: ${name}. Valid: ${STRATEGY_NAMES.join(', ')}`);
        }
        this.#strategyName = name.toLowerCase();
        this.#strategy = createStrategy(this.#strategyName, this.#settings);
        this.#settings.strategy = this.#strategyName;
        this.saveToDisk();
        logger.info(`[AccountManager] Strategy changed to ${this.getStrategyLabel()}`);
    }

    // ========== Status ==========

    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = getInvalid(this.#accounts);
        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            strategy: this.#strategyName,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                id: a.id,
                label: a.label,
                startUrl: a.startUrl,
                region: a.region,
                enabled: a.enabled !== false,
                modelRateLimits: a.modelRateLimits || {},
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                needsReauth: a.needsReauth || false,
                lastUsed: a.lastUsed,
                addedAt: a.addedAt
            }))
        };
    }

    // ========== Persistence ==========

    async saveToDisk() {
        await saveAccounts(
            this.#configPath,
            this.#accounts,
            this.#clientRegistration,
            this.#settings,
            this.#currentIndex
        );
    }
}

export { CooldownReason };
export default AccountManager;
