/**
 * Round-Robin Strategy
 * Rotate through available accounts on each request.
 */

import { BaseStrategy } from './base-strategy.js';

export class RoundRobinStrategy extends BaseStrategy {
    #lastIndex = -1;

    selectAccount(accounts, modelId, options = {}) {
        const available = this.getAvailableAccounts(accounts, modelId);

        if (available.length === 0) {
            return { account: null, index: options.currentIndex || 0, waitMs: 0 };
        }

        // Rotate to next available account
        this.#lastIndex++;
        if (this.#lastIndex >= available.length) {
            this.#lastIndex = 0;
        }

        const account = available[this.#lastIndex];
        const index = accounts.indexOf(account);

        return { account, index, waitMs: 0 };
    }
}
