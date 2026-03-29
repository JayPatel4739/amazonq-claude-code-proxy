/**
 * Rate Limit Tracking
 * Per-account, per-model rate limit state with cooldowns and progressive backoff.
 */

import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, COOLDOWN_MULTIPLIER, MAX_CONSECUTIVE_FAILURES } from '../constants.js';

export const CooldownReason = {
    RATE_LIMIT: 'rate_limit',
    AUTH_FAILURE: 'auth_failure',
    API_ERROR: 'api_error'
};

/**
 * Mark an account as rate-limited for a specific model
 */
export function markRateLimited(accounts, accountId, resetMs = null, modelId = null) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;

    if (!account.modelRateLimits) account.modelRateLimits = {};

    const key = modelId || '_global';
    const cooldown = resetMs || DEFAULT_RATE_LIMIT_COOLDOWN_MS;

    account.modelRateLimits[key] = {
        isRateLimited: true,
        resetTime: Date.now() + cooldown,
        limitedAt: Date.now()
    };

    // Track consecutive failures
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
}

/**
 * Mark an account as invalid (needs re-auth)
 */
export function markInvalid(accounts, accountId, reason = 'Unknown error') {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;

    account.isInvalid = true;
    account.invalidReason = reason;
    account.needsReauth = true;
}

/**
 * Clear invalid status for an account
 */
export function clearInvalid(accounts, accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;

    account.isInvalid = false;
    account.invalidReason = null;
    account.needsReauth = false;
}

/**
 * Clear expired rate limits across all accounts
 * Returns number of limits cleared
 */
export function clearExpiredLimits(accounts) {
    let cleared = 0;
    const now = Date.now();

    for (const account of accounts) {
        if (!account.modelRateLimits) continue;

        for (const [key, limit] of Object.entries(account.modelRateLimits)) {
            if (limit.isRateLimited && limit.resetTime <= now) {
                delete account.modelRateLimits[key];
                cleared++;
            }
        }
    }

    return cleared;
}

/**
 * Reset all rate limits (optimistic retry)
 */
export function resetAllRateLimits(accounts) {
    for (const account of accounts) {
        account.modelRateLimits = {};
        account.consecutiveFailures = 0;
    }
}

/**
 * Check if an account is rate-limited for a specific model
 */
export function isRateLimited(account, modelId = null) {
    if (!account.modelRateLimits) return false;

    const now = Date.now();
    const key = modelId || '_global';

    // Check model-specific limit
    const modelLimit = account.modelRateLimits[key];
    if (modelLimit?.isRateLimited && modelLimit.resetTime > now) return true;

    // Check global limit
    const globalLimit = account.modelRateLimits['_global'];
    if (globalLimit?.isRateLimited && globalLimit.resetTime > now) return true;

    return false;
}

/**
 * Get available (non-rate-limited, non-invalid, enabled) accounts
 */
export function getAvailableAccounts(accounts, modelId = null) {
    return accounts.filter(a =>
        a.enabled !== false &&
        !a.isInvalid &&
        !isRateLimited(a, modelId) &&
        !isAccountCoolingDown(a)
    );
}

/**
 * Get invalid accounts
 */
export function getInvalidAccounts(accounts) {
    return accounts.filter(a => a.isInvalid);
}

/**
 * Check if ALL enabled accounts are rate-limited
 */
export function isAllRateLimited(accounts, modelId = null) {
    const enabled = accounts.filter(a => a.enabled !== false && !a.isInvalid);
    if (enabled.length === 0) return false;
    return enabled.every(a => isRateLimited(a, modelId) || isAccountCoolingDown(a));
}

/**
 * Get minimum wait time until any account becomes available
 */
export function getMinWaitTimeMs(accounts, modelId = null) {
    const now = Date.now();
    let minWait = Infinity;

    for (const account of accounts) {
        if (account.enabled === false || account.isInvalid) continue;

        if (!account.modelRateLimits) return 0;

        const key = modelId || '_global';
        const limits = [
            account.modelRateLimits[key],
            account.modelRateLimits['_global']
        ].filter(Boolean);

        if (limits.length === 0) return 0;

        for (const limit of limits) {
            if (limit.isRateLimited && limit.resetTime > now) {
                minWait = Math.min(minWait, limit.resetTime - now);
            }
        }

        // Check cooldown
        if (account.cooldownUntil && account.cooldownUntil > now) {
            minWait = Math.min(minWait, account.cooldownUntil - now);
        }
    }

    return minWait === Infinity ? 0 : minWait;
}

/**
 * Get rate limit info for a specific account
 */
export function getRateLimitInfo(accounts, accountId, modelId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return { isRateLimited: false, resetMs: null, waitMs: 0 };

    const key = modelId || '_global';
    const limit = account.modelRateLimits?.[key];

    if (!limit?.isRateLimited || limit.resetTime <= Date.now()) {
        return { isRateLimited: false, resetMs: null, waitMs: 0 };
    }

    return {
        isRateLimited: true,
        resetMs: limit.resetTime,
        waitMs: limit.resetTime - Date.now()
    };
}

// Cooldown methods

export function markAccountCoolingDown(accounts, accountId, cooldownMs, reason = CooldownReason.RATE_LIMIT) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;

    account.cooldownUntil = Date.now() + cooldownMs;
    account.cooldownReason = reason;
}

export function isAccountCoolingDown(account) {
    return account.cooldownUntil && account.cooldownUntil > Date.now();
}

export function clearAccountCooldown(account) {
    delete account.cooldownUntil;
    delete account.cooldownReason;
}

export function getCooldownRemaining(account) {
    if (!account.cooldownUntil) return 0;
    const remaining = account.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}

// Consecutive failure tracking

export function getConsecutiveFailures(accounts, accountId) {
    const account = accounts.find(a => a.id === accountId);
    return account?.consecutiveFailures || 0;
}

export function resetConsecutiveFailures(accounts, accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (account) account.consecutiveFailures = 0;
}

export function incrementConsecutiveFailures(accounts, accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return 0;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    return account.consecutiveFailures;
}
