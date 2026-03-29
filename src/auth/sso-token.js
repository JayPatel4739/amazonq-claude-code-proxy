/**
 * SSO Token Manager
 *
 * Reads and refreshes AWS SSO/Builder ID tokens from ~/.aws/sso/cache/
 * Supports both Amazon Q (CodeWhisperer) and Kiro token formats.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');

// Cached token state
let cachedToken = null;
let cachedTokenExpiresAt = null;
let cachedProfileArn = null;

/**
 * Find all SSO cache files and return parsed contents
 */
function readSSOCacheFiles() {
    if (!fs.existsSync(SSO_CACHE_DIR)) {
        throw new Error(`SSO cache directory not found: ${SSO_CACHE_DIR}. Is Amazon Q installed and logged in?`);
    }

    const files = fs.readdirSync(SSO_CACHE_DIR).filter(f => f.endsWith('.json'));
    const parsed = [];

    for (const file of files) {
        try {
            const content = JSON.parse(fs.readFileSync(path.join(SSO_CACHE_DIR, file), 'utf8'));
            parsed.push({ file, ...content });
        } catch {
            // Skip unparseable files
        }
    }

    return parsed;
}

/**
 * Find ALL token files (files with accessToken), sorted by freshest expiry first
 */
function findAllTokenFiles() {
    const files = readSSOCacheFiles();

    const tokenFiles = files.filter(f => f.accessToken);

    if (tokenFiles.length === 0) {
        throw new Error(
            'No SSO token found in ~/.aws/sso/cache/. ' +
            'Make sure you are logged into Amazon Q in VS Code.'
        );
    }

    // Sort by expiry time (freshest first)
    return tokenFiles.sort((a, b) => {
        const aTime = new Date(a.expiresAt || 0).getTime();
        const bTime = new Date(b.expiresAt || 0).getTime();
        return bTime - aTime;
    });
}

/**
 * Find ALL client registrations (files with clientId + clientSecret, no accessToken)
 */
function findAllClientRegistrations() {
    const files = readSSOCacheFiles();

    return files.filter(f =>
        f.clientId &&
        f.clientSecret &&
        !f.accessToken
    );
}

/**
 * Find the matching client registration for a token file
 * Matches by clientId if the token file embeds one, otherwise tries all registrations
 */
function findClientRegistrationForToken(tokenData) {
    // If the token file itself has clientId + clientSecret, use those directly
    if (tokenData.clientId && tokenData.clientSecret) {
        return { clientId: tokenData.clientId, clientSecret: tokenData.clientSecret };
    }

    // Otherwise find from separate registration files
    const registrations = findAllClientRegistrations();

    // Filter for non-expired registrations
    const valid = registrations.filter(r => {
        if (!r.expiresAt) return true;
        return new Date(r.expiresAt).getTime() > Date.now();
    });

    if (valid.length === 0) return null;

    // Prefer registration with matching scopes (if token has scopes)
    if (tokenData.scopes) {
        const matching = valid.find(r =>
            r.scopes && JSON.stringify(r.scopes) === JSON.stringify(tokenData.scopes)
        );
        if (matching) return matching;
    }

    // Return the first valid registration
    return valid[0];
}

/**
 * Check if a token is expired (or will expire within 60 seconds)
 */
function isTokenExpired(expiresAt) {
    if (!expiresAt) return true;
    const expiryTime = new Date(expiresAt).getTime();
    return Date.now() >= (expiryTime - 60000);
}

/**
 * Refresh the SSO access token using the refresh token
 */
async function refreshToken(tokenData, clientReg) {
    logger.info(`[Auth] Refreshing expired token (file: ${tokenData.file})...`);

    const region = tokenData.region || 'us-east-1';
    const oidcEndpoint = `https://oidc.${region}.amazonaws.com/token`;

    const body = {
        grantType: 'refresh_token',
        clientId: clientReg.clientId,
        clientSecret: clientReg.clientSecret,
        refreshToken: tokenData.refreshToken
    };

    const response = await fetch(oidcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    logger.success(`[Auth] Token refreshed successfully (file: ${tokenData.file})`);

    // Update the cached token file on disk
    const tokenFilePath = path.join(SSO_CACHE_DIR, tokenData.file);
    try {
        const existingData = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
        existingData.accessToken = result.accessToken;
        existingData.expiresAt = new Date(Date.now() + (result.expiresIn * 1000)).toISOString();
        if (result.refreshToken) {
            existingData.refreshToken = result.refreshToken;
        }
        fs.writeFileSync(tokenFilePath, JSON.stringify(existingData, null, 2));
    } catch (err) {
        logger.warn(`[Auth] Could not update cache file: ${err.message}`);
    }

    return {
        accessToken: result.accessToken,
        expiresAt: new Date(Date.now() + (result.expiresIn * 1000)).toISOString(),
        profileArn: tokenData.profileArn || null
    };
}

/**
 * Try to get a valid token, attempting all token files and refresh strategies
 */
async function acquireToken() {
    const tokenFiles = findAllTokenFiles();
    const errors = [];

    for (const tokenData of tokenFiles) {
        // If token is still valid, use it directly
        if (!isTokenExpired(tokenData.expiresAt)) {
            logger.info(`[Auth] Using valid token from ${tokenData.file} (expires ${tokenData.expiresAt})`);
            return {
                accessToken: tokenData.accessToken,
                expiresAt: tokenData.expiresAt,
                profileArn: tokenData.profileArn || null
            };
        }

        // Token is expired - try to refresh
        if (!tokenData.refreshToken) {
            errors.push(`${tokenData.file}: no refresh token`);
            continue;
        }

        // Find a matching client registration
        const clientReg = findClientRegistrationForToken(tokenData);
        if (!clientReg) {
            errors.push(`${tokenData.file}: no valid client registration found`);
            continue;
        }

        try {
            const refreshed = await refreshToken(tokenData, clientReg);
            return refreshed;
        } catch (err) {
            errors.push(`${tokenData.file}: ${err.message}`);
            logger.warn(`[Auth] Refresh failed for ${tokenData.file}: ${err.message}`);

            // If the token file has its own clientId, also try other registrations
            if (tokenData.clientId) {
                const allRegs = findAllClientRegistrations();
                for (const altReg of allRegs) {
                    if (altReg.clientId === tokenData.clientId) continue; // Already tried
                    try {
                        const refreshed = await refreshToken(tokenData, altReg);
                        return refreshed;
                    } catch (altErr) {
                        errors.push(`${tokenData.file} + alt reg: ${altErr.message}`);
                    }
                }
            }
        }
    }

    throw new Error(
        'Could not acquire a valid token. Tried:\n  ' +
        errors.join('\n  ') +
        '\n\nPlease log in again via Amazon Q in VS Code.'
    );
}

/**
 * Get a valid SSO Bearer token
 */
export async function getToken() {
    if (cachedToken && !isTokenExpired(cachedTokenExpiresAt)) {
        return cachedToken;
    }

    const result = await acquireToken();
    cachedToken = result.accessToken;
    cachedTokenExpiresAt = result.expiresAt;
    cachedProfileArn = result.profileArn;

    return cachedToken;
}

/**
 * Get the profile ARN (if available, from Kiro or similar)
 */
export function getProfileArn() {
    return cachedProfileArn;
}

/**
 * Force refresh the token
 */
export async function forceRefresh() {
    cachedToken = null;
    cachedTokenExpiresAt = null;

    const result = await acquireToken();
    cachedToken = result.accessToken;
    cachedTokenExpiresAt = result.expiresAt;
    cachedProfileArn = result.profileArn;

    return cachedToken;
}

/**
 * Get auth status information
 */
export function getAuthStatus() {
    try {
        const tokenFiles = findAllTokenFiles();
        const best = tokenFiles[0]; // Freshest
        const expired = isTokenExpired(best.expiresAt);

        return {
            hasToken: true,
            expired,
            expiresAt: best.expiresAt,
            hasRefreshToken: !!best.refreshToken,
            region: best.region || 'us-east-1',
            startUrl: best.startUrl,
            source: best.file,
            profileArn: best.profileArn || null,
            tokenCount: tokenFiles.length
        };
    } catch (err) {
        return {
            hasToken: false,
            error: err.message
        };
    }
}
