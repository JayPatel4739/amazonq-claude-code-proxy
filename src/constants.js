/**
 * Shared constants
 */

import path from 'path';
import os from 'os';

export const DEFAULT_PORT = 9090;
export const REQUEST_BODY_LIMIT = '50mb';

// Config directory
export const CONFIG_DIR = path.join(os.homedir(), '.amazonq-claude-proxy');
export const ACCOUNT_CONFIG_PATH = path.join(CONFIG_DIR, 'accounts.json');
export const USAGE_HISTORY_PATH = path.join(CONFIG_DIR, 'usage-history.json');

// AWS SSO / OIDC
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_START_URL = 'https://view.awsapps.com/start';
export const CODEWHISPERER_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com';

export const SSO_OIDC_SCOPES = [
    'sso:account:access',
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations'
];

// Load balancing
export const SELECTION_STRATEGIES = ['sticky', 'round-robin', 'hybrid'];
export const DEFAULT_SELECTION_STRATEGY = 'hybrid';
export const STRATEGY_LABELS = {
    'sticky': 'Sticky (stay on one account)',
    'round-robin': 'Round Robin (rotate each request)',
    'hybrid': 'Hybrid (health-score weighted)'
};

// Rate limiting
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000; // 1 minute
export const MAX_CONSECUTIVE_FAILURES = 5;
export const COOLDOWN_MULTIPLIER = 2; // Exponential backoff multiplier

// Models
export const AVAILABLE_MODELS = [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', family: 'claude' },
    { id: 'claude-sonnet-4-6-thinking', name: 'Claude Sonnet 4.6 (Thinking)', family: 'claude' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', family: 'claude' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', family: 'claude' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', family: 'claude' }
];
