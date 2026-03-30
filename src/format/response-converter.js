/**
 * Response Converter
 * Converts Amazon Q chat responses to Anthropic Messages API format
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

/**
 * Parse tool_use blocks from text response
 * The model may output tool calls in XML format when instructed
 */
function parseToolUseBlocks(text) {
    const blocks = [];
    const toolUseRegex = /<tool_use\s+id="([^"]*?)"\s+name="([^"]*?)">\s*([\s\S]*?)\s*<\/tool_use>/g;
    let match;
    let lastIndex = 0;
    const textSegments = [];

    while ((match = toolUseRegex.exec(text)) !== null) {
        // Add text before this tool_use block
        const textBefore = text.substring(lastIndex, match.index).trim();
        if (textBefore) {
            textSegments.push(textBefore);
        }

        let input = {};
        try {
            let parsed = JSON.parse(match[3].trim());
            // Handle double-encoded JSON (string instead of object)
            while (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch { break; }
            }
            input = typeof parsed === 'object' && parsed !== null ? parsed : { text: String(parsed) };
        } catch {
            // If JSON parsing fails, try cleaning common issues
            const raw = match[3].trim();
            try {
                const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
                input = JSON.parse(cleaned);
            } catch {
                input = { text: raw };
            }
        }

        blocks.push({
            type: 'tool_use',
            id: match[1] || `toolu_${crypto.randomBytes(12).toString('hex')}`,
            name: match[2],
            input
        });

        lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last tool_use block
    const textAfter = text.substring(lastIndex).trim();
    if (textAfter) {
        textSegments.push(textAfter);
    }

    return { textSegments, toolUseBlocks: blocks };
}

/**
 * Convert Amazon Q response text to Anthropic content blocks
 *
 * @param {string} text - The response text from Amazon Q
 * @param {string} model - The model name for the response
 * @returns {Object} Anthropic Messages API format response
 */
export function convertQToAnthropic(text, model) {
    // Check for tool_use blocks in the response
    const { textSegments, toolUseBlocks } = parseToolUseBlocks(text);

    const content = [];
    let hasToolCalls = false;

    // Add text blocks
    for (const segment of textSegments) {
        if (segment) {
            content.push({ type: 'text', text: segment });
        }
    }

    // Add tool_use blocks
    for (const toolBlock of toolUseBlocks) {
        content.push(toolBlock);
        hasToolCalls = true;
    }

    // If no tool blocks were found, treat entire text as a text block
    if (content.length === 0) {
        content.push({ type: 'text', text: text || '' });
    }

    // Determine stop reason
    const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

    // Estimate token counts (rough approximation)
    const inputTokens = 0; // We don't know actual input tokens from Q
    const outputTokens = Math.ceil((text || '').length / 4);

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content,
        model: model || 'claude-sonnet-4-6',
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        }
    };
}

/**
 * Create a streaming message_start event
 */
export function createMessageStart(model) {
    return {
        type: 'message_start',
        message: {
            id: `msg_${crypto.randomBytes(16).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: model || 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0
            }
        }
    };
}

/**
 * Create a streaming content_block_start event
 */
export function createContentBlockStart(index, type = 'text', toolData = null) {
    if (type === 'tool_use' && toolData) {
        return {
            type: 'content_block_start',
            index,
            content_block: {
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: {}
            }
        };
    }
    return {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
    };
}

/**
 * Create a streaming content_block_delta event
 */
export function createContentBlockDelta(index, text, type = 'text_delta') {
    if (type === 'input_json_delta') {
        return {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: text }
        };
    }
    return {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
    };
}

/**
 * Create a streaming content_block_stop event
 */
export function createContentBlockStop(index) {
    return {
        type: 'content_block_stop',
        index
    };
}

/**
 * Create a streaming message_delta event
 */
export function createMessageDelta(stopReason = 'end_turn', outputTokens = 0) {
    return {
        type: 'message_delta',
        delta: {
            stop_reason: stopReason,
            stop_sequence: null
        },
        usage: {
            output_tokens: outputTokens
        }
    };
}

/**
 * Create a streaming message_stop event
 */
export function createMessageStop() {
    return {
        type: 'message_stop'
    };
}
