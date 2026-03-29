/**
 * AWS SSO Device Authorization Flow
 *
 * Implements standalone OAuth without needing VS Code.
 * Flow: Register client -> Device authorization -> Open browser -> Poll for token -> Refresh
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { DEFAULT_REGION, DEFAULT_START_URL, SSO_OIDC_SCOPES } from '../constants.js';

/**
 * Register a client with AWS SSO OIDC
 */
export async function registerClient(region = DEFAULT_REGION) {
    const endpoint = `https://oidc.${region}.amazonaws.com/client/register`;

    logger.debug('[SSOAuth] Registering client...');

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientName: 'amazonq-claude-proxy',
            clientType: 'public',
            scopes: SSO_OIDC_SCOPES
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Client registration failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    logger.success('[SSOAuth] Client registered successfully');

    return {
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        expiresAt: new Date(data.clientSecretExpiresAt * 1000).toISOString()
    };
}

/**
 * Start device authorization flow
 */
export async function startDeviceAuthorization(clientId, clientSecret, startUrl = DEFAULT_START_URL, region = DEFAULT_REGION) {
    const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;

    logger.debug('[SSOAuth] Starting device authorization...');

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientId,
            clientSecret,
            startUrl
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Device authorization failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    return {
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUri: data.verificationUri,
        verificationUriComplete: data.verificationUriComplete,
        expiresIn: data.expiresIn,
        interval: data.interval || 5
    };
}

/**
 * Open URL in default browser
 */
export async function openBrowser(url) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const platform = process.platform;
    try {
        if (platform === 'darwin') {
            await execAsync(`open "${url}"`);
        } else if (platform === 'win32') {
            await execAsync(`start "" "${url}"`);
        } else {
            await execAsync(`xdg-open "${url}"`);
        }
    } catch {
        logger.warn('[SSOAuth] Could not open browser automatically');
    }
}

/**
 * Poll for token after device authorization
 * Returns tokens when user completes browser auth
 */
export async function pollForToken(clientId, clientSecret, deviceCode, interval = 5, expiresIn = 600, region = DEFAULT_REGION) {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;
    const maxTime = Date.now() + (expiresIn * 1000);
    let pollInterval = interval;

    while (Date.now() < maxTime) {
        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientId,
                    clientSecret,
                    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
                    deviceCode
                })
            });

            if (response.ok) {
                const data = await response.json();
                logger.success('[SSOAuth] Token obtained successfully');
                return {
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresIn: data.expiresIn,
                    expiresAt: new Date(Date.now() + (data.expiresIn * 1000)).toISOString()
                };
            }

            const errorData = await response.json().catch(() => ({}));
            const errorCode = errorData.error || '';

            if (errorCode === 'authorization_pending') {
                // User hasn't completed auth yet, keep polling
                continue;
            } else if (errorCode === 'slow_down') {
                // Increase polling interval
                pollInterval += 5;
                continue;
            } else if (errorCode === 'expired_token') {
                throw new Error('Device authorization expired. Please try again.');
            } else {
                throw new Error(`Token polling failed: ${errorCode} - ${JSON.stringify(errorData)}`);
            }
        } catch (error) {
            if (error.message.includes('expired') || error.message.includes('Token polling failed')) {
                throw error;
            }
            // Network error, retry
            logger.debug(`[SSOAuth] Poll error: ${error.message}, retrying...`);
        }
    }

    throw new Error('Device authorization timed out. Please try again.');
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(clientId, clientSecret, refreshToken, region = DEFAULT_REGION) {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientId,
            clientSecret,
            grantType: 'refresh_token',
            refreshToken
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn: data.expiresIn,
        expiresAt: new Date(Date.now() + (data.expiresIn * 1000)).toISOString()
    };
}

/**
 * Complete the full device auth flow (for CLI / WebUI)
 * Returns { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }
 * Caller should then call pollForToken() to wait for completion.
 */
export async function initiateDeviceAuthFlow(clientRegistration, startUrl = DEFAULT_START_URL, region = DEFAULT_REGION) {
    let clientReg = clientRegistration;

    // Register client if needed
    if (!clientReg || !clientReg.clientId || isExpired(clientReg.expiresAt)) {
        clientReg = await registerClient(region);
    }

    // Start device auth
    const deviceAuth = await startDeviceAuthorization(
        clientReg.clientId,
        clientReg.clientSecret,
        startUrl,
        region
    );

    return {
        clientRegistration: clientReg,
        deviceAuth
    };
}

/**
 * Check if a timestamp is expired
 */
function isExpired(expiresAt) {
    if (!expiresAt) return true;
    return Date.now() >= new Date(expiresAt).getTime() - 60000;
}
