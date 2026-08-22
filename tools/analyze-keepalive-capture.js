/*
 * Safely compare the keepalive-relevant parts of an official protocol capture.
 *
 * The report intentionally omits login Codes, full handshake URLs, Gateway
 * tokens, account identifiers, and message bodies.
 *
 * Usage:
 *   pnpm -C core exec tsx ../tools/analyze-keepalive-capture.js <capture-dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');

const captureDir = path.resolve(String(process.argv[2] || '').trim());
const protoDir = path.resolve(__dirname, '../core/src/proto');

function requireCaptureDirectory() {
    if (!process.argv[2] || !fs.existsSync(captureDir) || !fs.statSync(captureDir).isDirectory()) {
        throw new Error('A protocol capture directory is required');
    }
}

function readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function numberValue(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function tokenShape(token) {
    const text = String(token || '');
    const validBase64 = text.length > 0
        && text.length % 4 === 0
        && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
    let decodedLength = null;
    if (validBase64) {
        try {
            decodedLength = Buffer.from(text, 'base64').length;
        } catch {}
    }
    return {
        length: text.length,
        padding: (text.match(/=+$/) || [''])[0].length,
        validBase64,
        decodedLength,
    };
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
}

function redactHandshakeCode(rawUrl) {
    const text = String(rawUrl || '').trim();
    const parsed = new URL(text);
    if (!parsed.searchParams.has('code')) return text;
    return text.replace(/([?&]code=)[^&#]*/g, '$1[REDACTED]');
}

function compareHandshakeUrls(rawUrls) {
    const urls = rawUrls.map(value => String(value || '').trim());
    const redactedUrls = urls.map(redactHandshakeCode);
    const codes = urls.map(value => new URL(value).searchParams.get('code') || '');
    const nonEmptyCodes = codes.filter(Boolean);
    return {
        count: urls.length,
        distinctUrlsIgnoringCode: new Set(redactedUrls).size,
        identicalExceptCode: urls.length > 0 && new Set(redactedUrls).size === 1,
        distinctCodes: new Set(nonEmptyCodes).size,
        allCodesPresentAndDistinct: nonEmptyCodes.length === urls.length
            && new Set(nonEmptyCodes).size === urls.length,
    };
}

function loadCryptoWasmForAudit() {
    const previousLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    try {
        return require('../core/src/utils/crypto-wasm.ts');
    } finally {
        if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = previousLogLevel;
    }
}

function publicHandshake(connection) {
    const urlFile = path.resolve(captureDir, String(connection.url_file || ''));
    const url = new URL(fs.readFileSync(urlFile, 'utf8').trim());
    return {
        connectionId: Number(connection.connection_id) || 0,
        platform: url.searchParams.get('platform') || '',
        os: url.searchParams.get('os') || '',
        version: url.searchParams.get('ver') || '',
        hasCode: url.searchParams.has('code') && !!url.searchParams.get('code'),
        codeLength: String(url.searchParams.get('code') || '').length,
        path: url.pathname,
        host: url.host,
    };
}

function topLevelFieldIds(buffer) {
    const reader = protobuf.Reader.create(buffer);
    const fields = new Set();
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wire = tag & 7;
        fields.add(field);
        if (wire === 0) reader.uint64();
        else if (wire === 1) reader.skip(8);
        else if (wire === 2) reader.bytes();
        else if (wire === 5) reader.skip(4);
        else throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    return [...fields].sort((a, b) => a - b);
}

async function main() {
    requireCaptureDirectory();
    const cryptoWasm = loadCryptoWasmForAudit();
    const root = new protobuf.Root();
    await root.load(
        fs.readdirSync(protoDir)
            .filter(name => name.endsWith('.proto'))
            .map(name => path.join(protoDir, name)),
        { keepCase: true },
    );

    const gate = root.lookupType('gatepb.Message');
    const loginRequest = root.lookupType('gamepb.userpb.LoginRequest');
    const heartbeatRequest = root.lookupType('gamepb.userpb.HeartbeatRequest');
    const manifest = readJsonLines(path.join(captureDir, 'manifest.jsonl'));
    const fileEntries = new Map(manifest.map(entry => [
        path.basename(String(entry.file || entry.path || entry.filename || '')),
        entry,
    ]));
    const connectionRecords = readJsonLines(path.join(captureDir, 'connections.jsonl'));
    const rawHandshakeUrls = connectionRecords.map(connection => {
        const urlFile = path.resolve(captureDir, String(connection.url_file || ''));
        return fs.readFileSync(urlFile, 'utf8').trim();
    });
    const connections = connectionRecords.map(publicHandshake);

    const tokenShapes = new Map();
    const tokens = new Set();
    const firstTokenByConnection = new Map();
    const notableTokens = [];
    const loginVersions = new Set();
    const heartbeatVersions = new Set();
    const heartbeatField3 = new Set();
    const heartbeatWireFields = new Set();
    const perConnection = new Map();
    let requestCount = 0;
    let loginCount = 0;
    let heartbeatCount = 0;

    for (const name of fs.readdirSync(captureDir).filter(item => /^\d+-send\.bin$/.test(item)).sort()) {
        let message;
        try {
            message = gate.decode(fs.readFileSync(path.join(captureDir, name)));
        } catch {
            continue;
        }
        if (numberValue(message.meta?.message_type) !== 1) continue;
        requestCount += 1;
        const manifestEntry = fileEntries.get(name) || {};
        const connectionId = Number(manifestEntry.connection_id) || 0;
        if (!perConnection.has(connectionId)) {
            perConnection.set(connectionId, {
                connectionId,
                requests: 0,
                logins: 0,
                heartbeats: 0,
                heartbeatIntervalsMs: [],
                lastHeartbeatAt: 0,
            });
        }
        const connection = perConnection.get(connectionId);
        connection.requests += 1;

        const token = String(message.token || '');
        tokens.add(token);
        if (!firstTokenByConnection.has(connectionId)) firstTokenByConnection.set(connectionId, token);
        const shape = tokenShape(token);

        const service = String(message.meta?.service_name || '');
        const method = String(message.meta?.method_name || '');
        const shapeKey = JSON.stringify(shape);
        if (!tokenShapes.has(shapeKey)) tokenShapes.set(shapeKey, { ...shape, count: 0, methods: new Set() });
        const shapeStats = tokenShapes.get(shapeKey);
        shapeStats.count += 1;
        shapeStats.methods.add(`${service}.${method}`);
        if (shape.length > 128) {
            notableTokens.push({
                connectionId,
                file: name,
                clientSeq: numberValue(message.meta?.client_seq),
                service,
                method,
                fingerprint: fingerprint(token),
                shape,
            });
        }
        if (service !== 'gamepb.userpb.UserService' || (method !== 'Login' && method !== 'Heartbeat')) continue;
        let body = Buffer.from(message.body || []);
        if (body.length) body = await cryptoWasm.decryptBuffer(body);

        if (method === 'Login') {
            const decoded = loginRequest.decode(body);
            loginVersions.add(String(decoded.device_info?.client_version || ''));
            loginCount += 1;
            connection.logins += 1;
        } else {
            const decoded = heartbeatRequest.decode(body);
            for (const field of topLevelFieldIds(body)) heartbeatWireFields.add(field);
            heartbeatVersions.add(String(decoded.client_version || ''));
            heartbeatField3.add(numberValue(decoded.field_3));
            heartbeatCount += 1;
            connection.heartbeats += 1;
            const sentAt = Number(manifestEntry.timestamp_ms) || 0;
            if (sentAt && connection.lastHeartbeatAt) {
                connection.heartbeatIntervalsMs.push(sentAt - connection.lastHeartbeatAt);
            }
            if (sentAt) connection.lastHeartbeatAt = sentAt;
        }
    }

    for (const connection of perConnection.values()) delete connection.lastHeartbeatAt;
    const firstTokenFingerprints = [...firstTokenByConnection.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([connectionId, token]) => ({ connectionId, fingerprint: fingerprint(token), shape: tokenShape(token) }));

    const result = {
        captureFormat: JSON.parse(fs.readFileSync(path.join(captureDir, 'session.json'), 'utf8')).format_version,
        handshakes: connections,
        handshakeComparison: compareHandshakeUrls(rawHandshakeUrls),
        requests: {
            total: requestCount,
            logins: loginCount,
            heartbeats: heartbeatCount,
            byConnection: [...perConnection.values()].sort((a, b) => a.connectionId - b.connectionId),
        },
        versions: {
            login: [...loginVersions].sort(),
            heartbeat: [...heartbeatVersions].sort(),
        },
        heartbeat: {
            field3Values: [...heartbeatField3].sort((a, b) => a - b),
            wireFieldIds: [...heartbeatWireFields].sort((a, b) => a - b),
        },
        gatewayToken: {
            distinctTokens: tokens.size,
            reusedTokens: Math.max(0, requestCount - tokens.size),
            firstByConnection: firstTokenFingerprints,
            distinctFirstTokens: new Set(firstTokenFingerprints.map(item => item.fingerprint)).size,
            notableTokens,
            shapes: [...tokenShapes.values()]
                .map(item => ({ ...item, methods: [...item.methods].sort() }))
                .sort((a, b) => a.length - b.length),
        },
        privacy: 'No Code, token, account identifier, full URL, or message body is included.',
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error?.message || String(error));
        process.exitCode = 1;
    });
}

module.exports = { compareHandshakeUrls, redactHandshakeCode };
