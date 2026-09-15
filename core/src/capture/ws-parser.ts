// @ts-nocheck
export {};
/**
 * WebSocket 帧解析器（流式）
 *
 * 只做“读”不做“写”，用于在中间人链路上复制一份服务器→客户端
 * 的 WebSocket 数据并解析出完整消息（opcode 2 二进制帧）。
 *
 * 支持：
 * - 分片（FIN=0 / 续帧 opcode 0）
 * - 掩码帧（客户端→服务器方向可能带掩码）
 * - 控制帧（close/ping/pong，不产生消息回调）
 * - 超长消息保护（maxPayload）
 */

const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;

/** 尝试解析头部，返回 { headerLen, opcode, fin, masked, length } 或 null（数据不足） */
function parseFrameHeader(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];

  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0F;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7F;
  let headerLen = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = (buffer[2] << 8) | buffer[3];
    headerLen = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    // 最高位必须为 0（RFC 6455 5.2）
    if ((buffer[2] & 0x80) !== 0) throw new Error('无效的 WebSocket 长度（64 位最高位非 0）');
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    length = high * 0x100000000 + low;
    headerLen = 10;
  }

  if (masked) headerLen += 4;
  return { headerLen, fin, opcode, masked, length };
}

class WsFrameParser {
  /**
   * @param {object} options
   * @param {(message: Buffer) => void} options.onMessage - 收到完整二进制消息
   * @param {() => void} [options.onClose] - 收到关闭帧
   * @param {(error: Error) => void} [options.onError] - 解析错误
   * @param {number} [options.maxPayload] - 单条消息上限
   */
  constructor(options = {}) {
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
    this.onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.maxPayload = options.maxPayload || DEFAULT_MAX_PAYLOAD;

    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentLength = 0;
    this.ended = false;
  }

  push(chunk) {
    if (this.ended || !chunk || chunk.length === 0) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._drain();
    } catch (error) {
      this.ended = true;
      this.onError(error);
    }
  }

  _emitMessage(message) {
    if (message.length === 0) return;
    if (this.onMessage) this.onMessage(message);
  }

  _drain() {
    while (this.buffer.length >= 2) {
      const header = parseFrameHeader(this.buffer);
      if (!header) return;

      const total = header.headerLen + header.length;
      if (this.buffer.length < total) return;

      let payload = this.buffer.slice(header.headerLen, header.headerLen + header.length);
      if (header.masked) {
        const mask = this.buffer.slice(header.headerLen - 4, header.headerLen);
        payload = unmask(payload, mask);
      }
      this.buffer = this.buffer.slice(total);

      // 控制帧
      if (header.opcode === 0x8) {
        this.ended = true;
        this.buffer = Buffer.alloc(0);
        this.onClose();
        return;
      }
      if (header.opcode === 0x9 || header.opcode === 0xA) {
        // ping / pong，忽略
        continue;
      }

      // 数据帧
      if (header.opcode === 0x0) {
        // 续帧
        if (this.fragmentOpcode === 0) continue; // 无起始帧，忽略
        this.fragmentLength += payload.length;
        if (this.fragmentLength > this.maxPayload) throw new Error('WebSocket 消息超过大小上限');
        this.fragments.push(payload);
        if (header.fin) {
          const message = Buffer.concat(this.fragments, this.fragmentLength);
          const opcode = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.fragmentLength = 0;
          if (opcode === 0x2) this._emitMessage(message);
        }
        continue;
      }

      // 起始数据帧（text=1 / binary=2）
      if (header.length > this.maxPayload) throw new Error('WebSocket 消息超过大小上限');
      if (header.fin) {
        if (header.opcode === 0x2) this._emitMessage(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = header.opcode;
        this.fragmentLength = payload.length;
      }
    }
  }
}

/** 按掩码对 payload 逐字节异或 */
function unmask(payload, mask) {
  const result = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    result[i] = payload[i] ^ mask[i % 4];
  }
  return result;
}

module.exports = {
  WsFrameParser,
  parseFrameHeader,
  unmask,
};
