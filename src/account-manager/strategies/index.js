/**
 * Strategy Factory
 */

import { StickyStrategy } from './sticky-strategy.js';
import { RoundRobinStrategy } from './round-robin-strategy.js';
import { HybridStrategy } from './hybrid-strategy.js';
import { SELECTION_STRATEGIES, DEFAULT_SELECTION_STRATEGY, STRATEGY_LABELS } from '../../constants.js';
import { logger } from '../../utils/logger.js';

export const STRATEGY_NAMES = SELECTION_STRATEGIES;
export const DEFAULT_STRATEGY = DEFAULT_SELECTION_STRATEGY;

export function createStrategy(strategyName, config = {}) {
    const name = (strategyName || DEFAULT_STRATEGY).toLowerCase();

    switch (name) {
        case 'sticky':
            return new StickyStrategy(config);
        case 'round-robin':
        case 'roundrobin':
            return new RoundRobinStrategy(config);
        case 'hybrid':
            return new HybridStrategy(config);
        default:
            logger.warn(`[Strategy] Unknown strategy "${strategyName}", using hybrid`);
            return new HybridStrategy(config);
    }
}

export function getStrategyLabel(name) {
    const lower = (name || DEFAULT_STRATEGY).toLowerCase();
    if (lower === 'roundrobin') return STRATEGY_LABELS['round-robin'];
    return STRATEGY_LABELS[lower] || STRATEGY_LABELS[DEFAULT_STRATEGY];
}

export function isValidStrategy(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return STRATEGY_NAMES.includes(lower) || lower === 'roundrobin';
}

export { StickyStrategy } from './sticky-strategy.js';
export { RoundRobinStrategy } from './round-robin-strategy.js';
export { HybridStrategy } from './hybrid-strategy.js';
export { BaseStrategy } from './base-strategy.js';
