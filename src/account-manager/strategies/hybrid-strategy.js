/**
 * Hybrid Strategy
 * Health-score weighted selection with progressive backoff.
 * Best for multiple accounts with varying reliability.
 */

import { BaseStrategy } from './base-strategy.js';

export class HybridStrategy extends BaseStrategy {
    #healthScores = new Map(); // accountId -> score (0-100)
    #maxScore = 100;
    #minUsableScore = 20;
    #recoveryAmount = 10;
    #failurePenalty = 25;
    #rateLimitPenalty = 40;

    selectAccount(accounts, modelId, options = {}) {
        const available = this.getAvailableAccounts(accounts, modelId);

        if (available.length === 0) {
            return { account: null, index: options.currentIndex || 0, waitMs: 0 };
        }

        // Initialize health scores for new accounts
        for (const acc of available) {
            if (!this.#healthScores.has(acc.id)) {
                this.#healthScores.set(acc.id, this.#maxScore);
            }
        }

        // Filter to usable accounts (above min score threshold)
        const usable = available.filter(a => {
            const score = this.#healthScores.get(a.id) || this.#maxScore;
            return score >= this.#minUsableScore;
        });

        const pool = usable.length > 0 ? usable : available;

        // Weighted random selection based on health scores
        const weights = pool.map(a => this.#healthScores.get(a.id) || this.#maxScore);
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);

        let random = Math.random() * totalWeight;
        let selected = pool[0];

        for (let i = 0; i < pool.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                selected = pool[i];
                break;
            }
        }

        const index = accounts.indexOf(selected);
        return { account: selected, index, waitMs: 0 };
    }

    onSuccess(account, modelId) {
        if (!account) return;
        const current = this.#healthScores.get(account.id) || this.#maxScore;
        this.#healthScores.set(account.id, Math.min(this.#maxScore, current + this.#recoveryAmount));
    }

    onRateLimit(account, modelId) {
        if (!account) return;
        const current = this.#healthScores.get(account.id) || this.#maxScore;
        this.#healthScores.set(account.id, Math.max(0, current - this.#rateLimitPenalty));
    }

    onFailure(account, modelId) {
        if (!account) return;
        const current = this.#healthScores.get(account.id) || this.#maxScore;
        this.#healthScores.set(account.id, Math.max(0, current - this.#failurePenalty));
    }

    getHealthScores() {
        const scores = {};
        for (const [id, score] of this.#healthScores) {
            scores[id] = Math.round(score * 10) / 10;
        }
        return scores;
    }
}
