/**
 * AWS Event Stream Binary Protocol Decoder
 *
 * Decodes the binary event stream format used by AWS streaming APIs.
 * Format per message:
 *   [total_length:4][headers_length:4][prelude_crc:4][headers:var][payload:var][message_crc:4]
 *
 * Reference: https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html
 */

/**
 * Parse headers from a buffer
 * Header format: [name_len:1][name:var][type:1][value depends on type]
 * String type (7): [value_len:2][value:var]
 */
function parseHeaders(buffer) {
    const headers = {};
    let offset = 0;

    while (offset < buffer.length) {
        // Header name length (1 byte)
        const nameLen = buffer.readUInt8(offset);
        offset += 1;

        // Header name
        const name = buffer.toString('utf8', offset, offset + nameLen);
        offset += nameLen;

        // Header value type (1 byte)
        const valueType = buffer.readUInt8(offset);
        offset += 1;

        switch (valueType) {
            case 7: { // String
                const valueLen = buffer.readUInt16BE(offset);
                offset += 2;
                const value = buffer.toString('utf8', offset, offset + valueLen);
                offset += valueLen;
                headers[name] = value;
                break;
            }
            case 0: { // Bool true
                headers[name] = true;
                break;
            }
            case 1: { // Bool false
                headers[name] = false;
                break;
            }
            case 2: { // Byte
                headers[name] = buffer.readInt8(offset);
                offset += 1;
                break;
            }
            case 3: { // Short
                headers[name] = buffer.readInt16BE(offset);
                offset += 2;
                break;
            }
            case 4: { // Int
                headers[name] = buffer.readInt32BE(offset);
                offset += 4;
                break;
            }
            case 5: { // Long (as BigInt)
                headers[name] = buffer.readBigInt64BE(offset);
                offset += 8;
                break;
            }
            case 6: { // Bytes
                const bytesLen = buffer.readUInt16BE(offset);
                offset += 2;
                headers[name] = buffer.subarray(offset, offset + bytesLen);
                offset += bytesLen;
                break;
            }
            case 8: { // Timestamp
                headers[name] = new Date(Number(buffer.readBigInt64BE(offset)));
                offset += 8;
                break;
            }
            case 9: { // UUID
                headers[name] = buffer.toString('hex', offset, offset + 16);
                offset += 16;
                break;
            }
            default:
                // Unknown type - skip rest
                return headers;
        }
    }

    return headers;
}

/**
 * Decode a single event stream message from a buffer
 * Returns { headers, payload, totalLength } or null if not enough data
 */
function decodeMessage(buffer, offset = 0) {
    // Need at least 12 bytes for prelude (total_len + headers_len + prelude_crc)
    if (buffer.length - offset < 12) return null;

    const totalLength = buffer.readUInt32BE(offset);
    const headersLength = buffer.readUInt32BE(offset + 4);
    // prelude CRC at offset + 8 (skip validation for simplicity)

    // Check if we have the full message
    if (buffer.length - offset < totalLength) return null;

    // Parse headers
    const headersStart = offset + 12; // After prelude (8 bytes) + prelude CRC (4 bytes)
    const headersBuffer = buffer.subarray(headersStart, headersStart + headersLength);
    const headers = parseHeaders(headersBuffer);

    // Parse payload
    const payloadStart = headersStart + headersLength;
    const payloadLength = totalLength - headersLength - 16; // 16 = prelude (8) + prelude_crc (4) + message_crc (4)
    const payload = buffer.subarray(payloadStart, payloadStart + payloadLength);

    return {
        headers,
        payload,
        totalLength
    };
}

/**
 * Create an async generator that yields decoded events from a readable stream
 */
export async function* decodeEventStream(readableStream) {
    let buffer = Buffer.alloc(0);

    for await (const chunk of readableStream) {
        // Append new data
        buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);

        // Try to decode messages
        while (true) {
            const message = decodeMessage(buffer);
            if (!message) break;

            // Advance buffer past this message
            buffer = buffer.subarray(message.totalLength);

            const messageType = message.headers[':message-type'];
            const eventType = message.headers[':event-type'];
            const contentType = message.headers[':content-type'];

            if (messageType === 'exception') {
                // Error event
                let errorPayload;
                try {
                    errorPayload = JSON.parse(message.payload.toString('utf8'));
                } catch {
                    errorPayload = { message: message.payload.toString('utf8') };
                }
                yield {
                    type: 'exception',
                    eventType: message.headers[':exception-type'] || 'UnknownException',
                    data: errorPayload
                };
                return;
            }

            if (messageType === 'event' && message.payload.length > 0) {
                let data;
                if (contentType === 'application/json') {
                    try {
                        data = JSON.parse(message.payload.toString('utf8'));
                    } catch {
                        data = { raw: message.payload.toString('utf8') };
                    }
                } else {
                    data = { raw: message.payload.toString('utf8') };
                }

                yield {
                    type: 'event',
                    eventType: eventType || 'unknown',
                    data
                };
            }
        }
    }
}
