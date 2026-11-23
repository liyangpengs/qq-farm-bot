import { MAX_IPC_FRAME_BYTES } from './constants';

export function encodeFrame(payload: unknown, maxBytes = MAX_IPC_FRAME_BYTES): Buffer {
    const json = JSON.stringify(payload);
    if (json === undefined) {
        throw Object.assign(new Error('IPC payload is not JSON-serializable'), { code: 'IPC_INVALID_PAYLOAD' });
    }
    const body = Buffer.from(json, 'utf8');
    if (body.length > maxBytes) {
        throw Object.assign(
            new Error(`IPC frame exceeds max size (${body.length} > ${maxBytes})`),
            { code: 'IPC_FRAME_TOO_LARGE', size: body.length, maxBytes },
        );
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return frame;
}

export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly maxBytes: number;
    private readonly onMessage: (msg: any) => void;
    private readonly onError: (error: Error) => void;

    constructor(
        onMessage: (msg: any) => void,
        onError: (error: Error) => void,
        maxBytes = MAX_IPC_FRAME_BYTES,
    ) {
        this.onMessage = onMessage;
        this.onError = onError;
        this.maxBytes = maxBytes;
    }

    push(chunk: Buffer): void {
        if (!chunk || chunk.length === 0) return;
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32BE(0);
            if (length === 0 || length > this.maxBytes) {
                this.buffer = Buffer.alloc(0);
                this.onError(Object.assign(
                    new Error(`Invalid IPC frame length: ${length} (max=${this.maxBytes})`),
                    { code: 'IPC_FRAME_TOO_LARGE', size: length, maxBytes: this.maxBytes },
                ));
                return;
            }
            if (this.buffer.length < 4 + length) return;

            const payloadBytes = this.buffer.subarray(4, 4 + length);
            this.buffer = this.buffer.subarray(4 + length);

            let parsed: any;
            try {
                parsed = JSON.parse(payloadBytes.toString('utf8'));
            } catch (error: any) {
                this.onError(Object.assign(
                    new Error(`Invalid IPC JSON frame: ${error?.message || error}`),
                    { code: 'IPC_MALFORMED_JSON' },
                ));
                return;
            }
            this.onMessage(parsed);
        }
    }

    reset(): void {
        this.buffer = Buffer.alloc(0);
    }
}
