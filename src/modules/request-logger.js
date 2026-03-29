/**
 * Request Logger
 * Circular buffer of recent requests for the log viewer.
 */

import crypto from 'crypto';

const DEFAULT_MAX_SIZE = 500;

class RequestLogger {
    #buffer = [];
    #maxSize;

    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.#maxSize = maxSize;
    }

    log(entry) {
        const logEntry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            model: entry.model || 'unknown',
            account: entry.account || 'unknown',
            status: entry.status || 0,
            duration: entry.duration || 0,
            stream: entry.stream || false,
            inputTokens: entry.inputTokens || 0,
            outputTokens: entry.outputTokens || 0,
            error: entry.error || null
        };

        this.#buffer.push(logEntry);

        if (this.#buffer.length > this.#maxSize) {
            this.#buffer.shift();
        }

        return logEntry;
    }

    getAll() {
        return [...this.#buffer];
    }

    getRecent(count = 50) {
        return this.#buffer.slice(-count);
    }

    query({ model, account, status, limit = 100 } = {}) {
        let results = this.#buffer;

        if (model) {
            results = results.filter(e => e.model === model);
        }
        if (account) {
            results = results.filter(e => e.account === account);
        }
        if (status) {
            if (status === '2xx') results = results.filter(e => e.status >= 200 && e.status < 300);
            else if (status === '4xx') results = results.filter(e => e.status >= 400 && e.status < 500);
            else if (status === '5xx') results = results.filter(e => e.status >= 500);
            else results = results.filter(e => e.status === parseInt(status, 10));
        }

        return results.slice(-limit);
    }

    clear() {
        this.#buffer = [];
    }

    get size() {
        return this.#buffer.length;
    }
}

// Singleton
const requestLogger = new RequestLogger();
export default requestLogger;
