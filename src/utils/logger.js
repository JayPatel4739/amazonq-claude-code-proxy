/**
 * Simple colored logger
 */

const COLORS = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

let debugEnabled = false;

function timestamp() {
    return new Date().toLocaleTimeString();
}

export const logger = {
    setDebug(enabled) {
        debugEnabled = enabled;
    },
    get isDebugEnabled() {
        return debugEnabled;
    },
    info(msg, ...args) {
        console.log(`${COLORS.cyan}[${timestamp()}]${COLORS.reset} ${msg}`, ...args);
    },
    success(msg, ...args) {
        console.log(`${COLORS.green}[${timestamp()}] ✓${COLORS.reset} ${msg}`, ...args);
    },
    warn(msg, ...args) {
        console.warn(`${COLORS.yellow}[${timestamp()}] !${COLORS.reset} ${msg}`, ...args);
    },
    error(msg, ...args) {
        console.error(`${COLORS.red}[${timestamp()}] ✗${COLORS.reset} ${msg}`, ...args);
    },
    debug(msg, ...args) {
        if (debugEnabled) {
            console.log(`${COLORS.gray}[${timestamp()}] [DEBUG]${COLORS.reset} ${msg}`, ...args);
        }
    },
    log(msg, ...args) {
        console.log(msg, ...args);
    }
};
