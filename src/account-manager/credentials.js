/**
 * Credentials Manager
 * Handles token caching, refresh, and profile ARN discovery for accounts.
 */

import { refreshAccessToken } from '../auth/sso-oauth.js';
import { logger } from '../utils/logger.js';

/**
 * Get a valid access token for an account, refreshing if needed
 *
 * @param {Object} account - Account object with refreshToken, region
 * @param {Object} clientRegistration - Client registration with clientId, clientSecret
 * @param {Map} tokenCache - In-memory token cache
 * @param {Function} onInvalid - Callback when account becomes invalid (email, reason)
 * @param {Function} onSave - Callback to persist changes
 * @returns {Promise<string>} Valid access token
 */
export async function getTokenForAccount(account, clientRegistration, tokenCache, onInvalid, onSave) {
    const cacheKey = account.id;

    // Check cache first
    const cached = tokenCache.get(cacheKey);
    if (cached && !isExpired(cached.expiresAt)) {
        return cached.accessToken;
    }

    // Need to refresh
    if (!account.refreshToken) {
        onInvalid(account.id, 'No refresh token available');
        throw new Error(`No refresh token for account ${account.label || account.id}`);
    }

    if (!clientRegistration || !clientRegistration.clientId) {
        throw new Error('No client registration available. Please add an account first.');
    }

    try {
        const result = await refreshAccessToken(
            clientRegistration.clientId,
            clientRegistration.clientSecret,
            account.refreshToken,
            account.region
        );

        // Update cache
        tokenCache.set(cacheKey, {
            accessToken: result.accessToken,
            expiresAt: result.expiresAt
        });

        // Update refresh token if rotated
        if (result.refreshToken && result.refreshToken !== account.refreshToken) {
            account.refreshToken = result.refreshToken;
            if (onSave) onSave();
        }

        logger.debug(`[Credentials] Token refreshed for ${account.label || account.id}`);

        return result.accessToken;
    } catch (error) {
        logger.error(`[Credentials] Token refresh failed for ${account.label || account.id}: ${error.message}`);

        if (error.message.includes('invalid_grant') || error.message.includes('expired')) {
            onInvalid(account.id, `Refresh token expired: ${error.message}`);
            account.needsReauth = true;
            if (onSave) onSave();
        }

        throw error;
    }
}

/**
 * Clear token cache for an account or all
 */
export function clearTokenCache(tokenCache, accountId = null) {
    if (accountId) {
        tokenCache.delete(accountId);
    } else {
        tokenCache.clear();
    }
}

function isExpired(expiresAt) {
    if (!expiresAt) return true;
    return Date.now() >= new Date(expiresAt).getTime() - 60000;
}
