/**
 * Request Converter
 * Converts Anthropic Messages API requests to Amazon Q conversationState format
 */

import { logger } from '../utils/logger.js';

/**
 * Convert a single Anthropic content block to plain text
 */
function contentBlockToText(block) {
    if (typeof block === 'string') return block;

    switch (block.type) {
        case 'text':
            return block.text || '';
        case 'thinking':
            return `<thinking>${block.thinking || ''}</thinking>`;
        case 'tool_use':
            return `<tool_use id="${block.id}" name="${block.name}">\n${JSON.stringify(block.input, null, 2)}\n</tool_use>`;
        case 'tool_result':
            const resultContent = Array.isArray(block.content)
                ? block.content.map(contentBlockToText).join('\n')
                : (typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
            return `<tool_result tool_use_id="${block.tool_use_id}"${block.is_error ? ' is_error="true"' : ''}>\n${resultContent}\n</tool_result>`;
        case 'image':
            return '[Image content]';
        default:
            return JSON.stringify(block);
    }
}

/**
 * Convert message content (string or array of blocks) to plain text
 */
function messageContentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(contentBlockToText).join('\n');
    }
    return String(content);
}

/**
 * Build tool definitions as text for the system prompt
 */
function buildToolsPrompt(tools) {
    if (!tools || tools.length === 0) return '';

    let prompt = '\n\n## Available Tools\n\n';
    prompt += 'You have access to the following tools. To use a tool, output a tool_use block in this exact format:\n\n';
    prompt += '```\n<tool_use id="unique_id" name="tool_name">\n{"param": "value"}\n</tool_use>\n```\n\n';
    prompt += 'When you want to use a tool, you MUST output the tool_use XML block. ';
    prompt += 'After the tool is executed, the result will be provided in a tool_result block.\n\n';
    prompt += 'Here are the available tools:\n\n';

    for (const tool of tools) {
        const name = tool.name || tool.function?.name || 'unknown';
        const description = tool.description || tool.function?.description || '';
        const schema = tool.input_schema || tool.function?.parameters || {};

        prompt += `### ${name}\n`;
        prompt += `${description}\n`;
        prompt += `Parameters: ${JSON.stringify(schema, null, 2)}\n\n`;
    }

    return prompt;
}

/**
 * Convert Anthropic Messages API request to Amazon Q conversationState
 *
 * @param {Object} anthropicRequest - The Anthropic format request
 * @returns {Object} Amazon Q conversationState
 */
export function convertAnthropicToQ(anthropicRequest) {
    const { system, messages, tools, model } = anthropicRequest;

    // Build system prompt (including tool definitions)
    let systemPrompt = '';
    if (system) {
        if (typeof system === 'string') {
            systemPrompt = system;
        } else if (Array.isArray(system)) {
            systemPrompt = system.filter(b => b.type === 'text').map(b => b.text).join('\n');
        }
    }

    // Add tool definitions to system prompt
    if (tools && tools.length > 0) {
        systemPrompt += buildToolsPrompt(tools);
    }

    // Convert messages to Q format
    // Amazon Q expects a simple currentMessage + history format
    // We need to flatten the conversation

    // Build history from all messages except the last user message
    const history = [];
    let currentUserMessage = '';

    // Find the last user message as the current message
    const lastUserIndex = findLastIndex(messages, m => m.role === 'user');

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const text = messageContentToText(msg.content);

        if (i === lastUserIndex) {
            // This is the current message
            currentUserMessage = text;

            // If there's a system prompt and this is the first/only user message,
            // prepend it as context
            if (systemPrompt && history.length === 0) {
                currentUserMessage = `[System Instructions]\n${systemPrompt}\n\n[User Message]\n${text}`;
            }
        } else {
            // Add to history
            if (msg.role === 'user') {
                let content = text;
                // Prepend system prompt to first user message in history
                if (systemPrompt && history.length === 0) {
                    content = `[System Instructions]\n${systemPrompt}\n\n[User Message]\n${text}`;
                }
                history.push({
                    userInputMessage: {
                        content: content
                    }
                });
            } else if (msg.role === 'assistant') {
                history.push({
                    assistantResponseMessage: {
                        content: text
                    }
                });
            }
        }
    }

    // If no user message found, use a default
    if (!currentUserMessage && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        currentUserMessage = messageContentToText(lastMsg.content);
    }

    const conversationState = {
        currentMessage: {
            userInputMessage: {
                content: currentUserMessage,
                userInputMessageContext: {}
            }
        },
        chatTriggerType: 'MANUAL'
    };

    // Only add history if non-empty
    if (history.length > 0) {
        conversationState.history = history;
    }

    logger.debug(`[RequestConverter] Converted ${messages.length} messages, history: ${history.length}`);

    return conversationState;
}

/**
 * Find the last index of an element matching a predicate
 */
function findLastIndex(arr, predicate) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (predicate(arr[i])) return i;
    }
    return -1;
}
