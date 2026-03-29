/**
 * Base Strategy - Abstract base class for account selection strategies
 */

export class BaseStrategy {
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * Select an account from the available pool
     * @param {Array} accounts - All accounts
     * @param {string} modelId - Model being requested
     * @param {Object} options - { currentIndex, onSave, sessionId }
     * @returns {{ account: Object|null, index: number, waitMs: number }}
     */
    selectAccount(accounts, modelId, options = {}) {
        throw new Error('selectAccount() must be implemented by subclass');
    }

    onSuccess(account, modelId) {}
    onRateLimit(account, modelId) {}
    onFailure(account, modelId) {}

    /**
     * Get enabled, non-invalid accounts that are not rate-limited
     */
    getAvailableAccounts(accounts, modelId = null) {
        const now = Date.now();
        return accounts.filter(a => {
            if (a.enabled === false || a.isInvalid) return false;
            if (a.cooldownUntil && a.cooldownUntil > now) return false;
            if (!a.modelRateLimits) return true;

            const key = modelId || '_global';
            const modelLimit = a.modelRateLimits[key];
            if (modelLimit?.isRateLimited && modelLimit.resetTime > now) return false;
            const globalLimit = a.modelRateLimits['_global'];
            if (globalLimit?.isRateLimited && globalLimit.resetTime > now) return false;

            return true;
        });
    }
}
