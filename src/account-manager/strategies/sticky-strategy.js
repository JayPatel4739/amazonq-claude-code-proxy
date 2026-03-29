/**
 * Sticky Strategy
 * Stay on current account until it's rate-limited or invalid, then move to next.
 */

import { BaseStrategy } from './base-strategy.js';

export class StickyStrategy extends BaseStrategy {
    selectAccount(accounts, modelId, options = {}) {
        const available = this.getAvailableAccounts(accounts, modelId);

        if (available.length === 0) {
            return { account: null, index: options.currentIndex || 0, waitMs: 0 };
        }

        // Try to stay on current account
        const currentIndex = options.currentIndex || 0;
        const currentAccount = accounts[currentIndex];

        if (currentAccount && available.includes(currentAccount)) {
            return { account: currentAccount, index: currentIndex, waitMs: 0 };
        }

        // Current account unavailable, find next available
        const nextAccount = available[0];
        const nextIndex = accounts.indexOf(nextAccount);

        return { account: nextAccount, index: nextIndex, waitMs: 0 };
    }
}
