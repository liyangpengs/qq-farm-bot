export {};
const crypto = require('node:crypto');

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function createGatewayToken(): string {
    const length = 64 + crypto.randomInt(64);
    const bytes: Buffer = crypto.randomBytes(length);
    let token = '';
    for (let i = 0; i < length; i++) {
        token += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    }
    return `${token}=`;
}

class GatewayTokenProvider {
    private pendingInitToken = '';

    stageInitToken(value: unknown): number {
        const token = String(value || '').trim();
        if (!token) return 0;
        if (token.length > 64 * 1024 || !/^[\x21-\x7E]+$/.test(token)) {
            throw new Error('TSDK 初始化凭据格式无效');
        }
        this.pendingInitToken = token;
        return token.length;
    }

    next(): string {
        if (!this.pendingInitToken) return createGatewayToken();
        const token = this.pendingInitToken;
        this.pendingInitToken = '';
        return token;
    }

    clear(): void {
        this.pendingInitToken = '';
    }
}

module.exports = { createGatewayToken, GatewayTokenProvider };
