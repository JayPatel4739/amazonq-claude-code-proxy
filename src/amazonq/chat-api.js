/**
 * Amazon Q Chat API Client
 *
 * Calls the CodeWhisperer streaming API (generateAssistantResponse)
 * and decodes the AWS event stream response.
 */

import crypto from 'crypto';
import { decodeEventStream } from './event-stream-decoder.js';
import { logger } from '../utils/logger.js';
import { CODEWHISPERER_ENDPOINT } from '../constants.js';

/**
 * Send a chat message to Amazon Q via the CodeWhisperer streaming API
 *
 * @param {Object} conversationState - The conversation state object
 * @param {string} token - Bearer token for authentication
 * @param {string|null} profileArn - Optional profile ARN
 * @returns {AsyncGenerator} Yields event objects from the stream
 */
export async function* sendChatMessage(conversationState, token, profileArn = null) {
    const url = `${CODEWHISPERER_ENDPOINT}/generateAssistantResponse`;

    const body = {
        conversationState,
    };
    if (profileArn) {
        body.profileArn = profileArn;
    }

    logger.debug(`[AmazonQ] POST ${url}`);
    logger.debug(`[AmazonQ] Request body: ${JSON.stringify(body).substring(0, 500)}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'x-amzn-codewhisperer-optout': 'false',
            'amz-sdk-invocation-id': crypto.randomUUID(),
            'amz-sdk-request': 'attempt=1; max=3'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[AmazonQ] API error: ${response.status} ${errorText}`);

        if (response.status === 401 || response.status === 403) {
            throw new Error(`AUTH_ERROR: ${response.status} - ${errorText}`);
        }
        if (response.status === 429) {
            throw new Error(`RATE_LIMITED: ${response.status} - ${errorText}`);
        }
        throw new Error(`API_ERROR: ${response.status} - ${errorText}`);
    }

    // Check content type
    const contentType = response.headers.get('content-type') || '';
    logger.debug(`[AmazonQ] Response content-type: ${contentType}`);

    logger.debug('[AmazonQ] Attempting to decode as binary event stream');
    try {
        let yieldedAny = false;
        for await (const event of decodeEventStream(response.body)) {
            if (event.type === 'exception') {
                throw new Error(`STREAM_ERROR: ${event.eventType} - ${JSON.stringify(event.data)}`);
            }
            yieldedAny = true;
            yield event;
        }
        if (yieldedAny) {
            logger.debug('[AmazonQ] Successfully decoded event stream');
            return;
        }
    } catch (streamErr) {
        logger.debug(`[AmazonQ] Event stream decode failed: ${streamErr.message}`);
        throw streamErr;
    }
}

/**
 * Collect all response text from a chat stream
 */
export async function collectChatResponse(conversationState, token, profileArn = null) {
    let fullContent = '';
    let conversationId = null;

    for await (const event of sendChatMessage(conversationState, token, profileArn)) {
        if (event.eventType === 'assistantResponseEvent') {
            const content = event.data?.content || event.data?.assistantResponseEvent?.content || '';
            fullContent += content;
        } else if (event.eventType === 'messageMetadataEvent') {
            conversationId = event.data?.conversationId ||
                event.data?.messageMetadataEvent?.conversationId;
        }
    }

    return { content: fullContent, conversationId };
}
