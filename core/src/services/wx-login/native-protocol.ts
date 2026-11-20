import crypto from 'node:crypto';
import net from 'node:net';

// 这三个模块用 module.exports 导出（运行时值），所以走 require 而不是 import。
const { resolveTargets } = require('./httpdns');
const { loginBudget } = require('./login-budget');
const { getCachedSession, invalidateCachedSession, sessionCacheKey, setCachedSession } = require('./session-cache');

type Target = { host: string; port: number };
type Session = { sendKey: Buffer; recvKey: Buffer; f9: Buffer; uin: bigint; deviceId: Buffer; hostAppId: Buffer; psk: Buffer; ticket: Buffer };
const U8 = Buffer.from;
const REC = 0xF103;
const HOST_APP = U8('wxd44977328b36e647');
const SERVER_PUB = Buffer.from('04ef87876d6478b15f1796eab12068610541173b7176b67f1dcc86683e901acd44d18b4ac36938251d0812dd0cf842aa2d6cbb8115712d1c0087dcefc14a44cd58', 'hex');
const TRANSFER_PATH = U8('/ilink/ilinkapp/mp/wxaruntime_transfer');
const TRANSFER_HOST = U8('shortcloud.weixin.com');

const vi = (n: number | bigint) => { let v = BigInt(n); const out: number[] = []; do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; out.push(b); } while (v); return Buffer.from(out); };
const pbl = (f: number, b: Buffer) => Buffer.concat([vi(f * 8 + 2), vi(b.length), b]);
const pbv = (f: number, n: number | bigint) => Buffer.concat([vi(f * 8), vi(n)]);
function rvi(b: Buffer, o: number) { let n = 0n; let s = 0n; for (; o < b.length; o++) { const x = b[o]; n |= BigInt(x & 127) << s; if (!(x & 128)) return [n, o + 1] as const; s += 7n; } throw new Error('truncated varint'); }
function pbf(b: Buffer) { const out = new Map<number, Buffer | bigint>(); let o = 0; while (o < b.length) { const [tag, a] = rvi(b, o); o = a; const f = Number(tag >> 3n); if ((tag & 7n) === 0n) { const [n, z] = rvi(b, o); out.set(f, n); o = z; } else if ((tag & 7n) === 2n) { const [n, z] = rvi(b, o); o = z; const e = o + Number(n); if (e > b.length) throw new Error('truncated protobuf'); out.set(f, b.subarray(o, e)); o = e; } else break; } return out; }
const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();
function expand(secret: Buffer, label: string, context: Buffer, size: number) { const out: Buffer[] = []; let prev = Buffer.alloc(0); for (let c = 1; Buffer.concat(out).length < size; c++) { prev = hmac(secret, Buffer.concat([prev, U8(label), context, Buffer.from([c])])); out.push(prev); } return Buffer.concat(out).subarray(0, size); }
function extract(salt: Buffer, data: Buffer) { return hmac(salt, data); }
function nonce(iv: Buffer, seq: number) { const n = Buffer.from(iv); const s = Buffer.alloc(8); s.writeBigUInt64BE(BigInt(seq)); for (let i = 0; i < 8; i++) n[n.length - 8 + i] ^= s[i]; return n; }
function gcm(key: Buffer, iv: Buffer, seq: number, type: number, data: Buffer, decrypt = false) { const aad = Buffer.alloc(13); aad.writeBigUInt64BE(BigInt(seq)); aad[8] = type; aad.writeUInt16BE(REC, 9); aad.writeUInt16BE(decrypt ? data.length : data.length + 16, 11); const algo = `aes-${key.length * 8}-gcm`; if (decrypt) { const d: any = crypto.createDecipheriv(algo, key, nonce(iv, seq)); d.setAAD(aad); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]); } const c: any = crypto.createCipheriv(algo, key, nonce(iv, seq)); c.setAAD(aad); return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]); }
function layout(key: Buffer, plain: Buffer, aad = Buffer.alloc(0)) { const iv = crypto.randomBytes(12); const c: any = crypto.createCipheriv(`aes-${key.length * 8}-gcm`, key, iv); c.setAAD(aad); return Buffer.concat([c.update(plain), c.final(), iv, c.getAuthTag()]); }
function unlayout(key: Buffer, blob: Buffer, aad = Buffer.alloc(0)) { const split = blob.length - 28; const d: any = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, blob.subarray(split, split + 12)); d.setAAD(aad); d.setAuthTag(blob.subarray(split + 12)); return Buffer.concat([d.update(blob.subarray(0, split)), d.final()]); }
const rec = (type: number, body: Buffer) => { const h = Buffer.alloc(5); h[0] = type; h.writeUInt16BE(REC, 1); h.writeUInt16BE(body.length, 3); return Buffer.concat([h, body]); };
function records(data: Buffer) { const out: { type: number; body: Buffer }[] = []; for (let o = 0; o + 5 <= data.length;) { const n = data.readUInt16BE(o + 3); if (data.readUInt16BE(o + 1) !== REC || o + 5 + n > data.length) break; out.push({ type: data[o], body: data.subarray(o + 5, o + 5 + n) }); o += 5 + n; } return out; }
const hs = (type: number, body: Buffer) => { const h = Buffer.alloc(5); h.writeUInt32BE(body.length + 1); h[4] = type; return Buffer.concat([h, body]); };
function splitHs(b: Buffer) { if (b.length < 5 || b.readUInt32BE() + 4 > b.length) throw new Error('invalid handshake'); return { type: b[4], body: b.subarray(5) }; }
function lz4Literal(data: Buffer) { if (data.length < 15) return Buffer.concat([Buffer.from([data.length << 4]), data]); const xs: number[] = [0xF0]; for (let n = data.length - 15; n >= 255; n -= 255) xs.push(255); xs.push((data.length - 15) % 255); return Buffer.concat([Buffer.from(xs), data]); }
function lz4(data: Buffer) { const out: number[] = []; for (let i = 0; i < data.length;) { const t = data[i++]; let n = t >> 4; if (n === 15) { let x; do { x = data[i++]; n += x; } while (x === 255); } for (let e = i + n; i < e; i++) out.push(data[i]); if (i >= data.length) break; const off = data.readUInt16LE(i); i += 2; let m = (t & 15) + 4; if ((t & 15) === 15) { let x; do { x = data[i++]; m += x; } while (x === 255); } for (let j = 0; j < m; j++) out.push(out[out.length - off]); } return Buffer.from(out); }
function wpkg(ints: Record<number, number | bigint>, bytes: Record<number, Buffer>) { const a: Buffer[] = [vi(1)]; for (const k of Object.keys(ints).map(Number).sort((x, y) => x - y)) a.push(vi(k), vi(ints[k])); a.push(vi(0)); for (const k of Object.keys(bytes).map(Number).sort((x, y) => x - y)) a.push(vi(k), vi(bytes[k].length), bytes[k]); const p = Buffer.concat(a); return Buffer.concat([p, vi(0), vi(p.length + 1)]); }
function readWpkg(b: Buffer) { let o = 0; [, o] = rvi(b, o); for (;;) { const [f, n] = rvi(b, o); o = n; if (!f) break; [, o] = rvi(b, o); } for (;;) { const [f, n] = rvi(b, o); o = n; if (!f) break; const [l, z] = rvi(b, o); o = z + Number(l); } [, o] = rvi(b, o); return o; }
function short(cmd: number, seq: number, body: Buffer) { const b = Buffer.alloc(16); b.writeUInt32BE(16 + body.length); b.writeUInt16BE(0x1110, 4); b.writeUInt16BE(0x076D, 6); b.writeUInt32BE(cmd, 8); b.writeUInt32BE(seq, 12); return Buffer.concat([b, body]); }
function parseShort(b: Buffer) { if (b.length < 16 || b.readUInt32BE() > b.length) throw new Error('invalid shortlink'); return { cmd: b.readUInt32BE(8), body: b.subarray(16, b.readUInt32BE()) }; }
function ecdh() { const e = crypto.createECDH('prime256v1'); return { e, pub: e.generateKeys() }; }
function ch(pub1: Buffer, pub2: Buffer) { const r = crypto.randomBytes(32); const b: Buffer[] = [Buffer.from([3, 0xF1, 1, 0xC0, 0x2B]), r, Buffer.alloc(4)]; b[2].writeUInt32BE(Math.floor(Date.now() / 1000)); const offers = [pub1, pub2].map((p, i) => { const x = Buffer.alloc(6); x.writeUInt32BE(i ? 2 : 1); x.writeUInt16BE(65, 4); const z = Buffer.concat([x, p]); const n = Buffer.alloc(4); n.writeUInt32BE(z.length); return Buffer.concat([n, z]); }); const ks = Buffer.concat([Buffer.from([0, 16, 2]), ...offers, Buffer.from([0, 0, 0, 1])]); const ext = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), ks]); ext.writeUInt32BE(ks.length, 1); const n = Buffer.alloc(4); n.writeUInt32BE(ext.length); return hs(1, Buffer.concat([...b, n, ext])); }
function pskClientHello(ticket: Buffer, timestamp: number) {
    const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
    const ticketExtension = Buffer.concat([Buffer.from([0x00, 0x0F, 0x01]), u32(ticket.length), ticket]);
    const extension = Buffer.concat([Buffer.from([0x01]), u32(ticketExtension.length), ticketExtension]);
    const body = Buffer.concat([
        Buffer.from([0x03, 0xF1, 0x01, 0x00, 0xA8]),
        crypto.randomBytes(32),
        u32(timestamp),
        u32(extension.length),
        extension,
    ]);
    return hs(0x01, body);
}
async function socket(host: string, port: number, timeout = 30000) {
    const s = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let ended = false;
    s.on('data', x => chunks.push(Buffer.from(x)));
    s.on('end', () => { ended = true; });
    // 连接超时定时器原来既不保存句柄也不清理：即使 100ms 就连上，30s 的活定时器
    // 仍挂在 event loop 上拖住 worker 退出；连接失败时 socket 也没人关。
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((ok, no) => {
            s.once('connect', ok);
            s.once('error', no);
            connectTimer = setTimeout(() => no(new Error('connection timeout')), timeout);
        });
    } catch (error) {
        s.destroy();
        throw error;
    } finally {
        if (connectTimer) clearTimeout(connectTimer);
    }
    let offset = 0;
    async function take() {
        const until = Date.now() + timeout;
        for (;;) {
            const all = Buffer.concat(chunks);
            if (all.length - offset >= 5) {
                const n = all.readUInt16BE(offset + 3);
                if (all.length - offset >= n + 5) {
                    const out = { type: all[offset], body: all.subarray(offset + 5, offset + 5 + n) };
                    offset += 5 + n;
                    return out;
                }
            }
            if (ended || Date.now() > until) throw new Error('socket read timeout');
            await new Promise(r => setTimeout(r, 10));
        }
    }
    return {
        s,
        take,
        send: (b: Buffer) => new Promise<void>((ok, no) => s.write(b, e => e ? no(e) : ok())),
        close: () => s.destroy(),
    };
}
function keys(secret: Buffer, label: string, hash: Buffer, size = 56) { const z = expand(secret, label, hash, size); return { ck: z.subarray(0, 16), sk: z.subarray(16, 32), ci: z.subarray(32, 44), si: z.subarray(44, 56) }; }
function oneWayKeys(secret: Buffer, label: string, hash: Buffer) { const z = expand(secret, label, hash, 28); return { key: z.subarray(0, 16), iv: z.subarray(16, 28) }; }
function manualRequest(buffer: string, app: Buffer) { const raw = Buffer.from(buffer, 'base64'); const f = pbf(raw); const ticket = f.get(1); const device = f.get(2); const host = f.get(3); if (!Buffer.isBuffer(ticket) || !ticket.length || !Buffer.isBuffer(device) || !device.length) throw new Error('invalid login buffer'); const base = Buffer.concat([pbl(1, app), pbv(2, 1901)]); const req = Buffer.concat([pbl(1, base), pbl(3, pbl(1, ticket)), pbv(4, 4), pbl(6, Buffer.alloc(0)), pbv(7, 0), pbv(8, 6)]); return { req, device, host: Buffer.isBuffer(host) && host.length ? host : HOST_APP }; }
function hybrid(plain: Buffer) { const x = ecdh(); const secret = crypto.createHash('sha256').update(x.e.computeSecret(SERVER_PUB)).digest(); const h1 = crypto.createHash('sha256').update(Buffer.concat([U8('1'), U8('415'), x.pub])).digest(); const cek = crypto.randomBytes(32); const encKey = layout(secret.subarray(0, 24), cek, h1); const okm = expand(extract(U8('security hdkf expand'), cek), '', h1, 56); const comp = lz4Literal(plain); const h2 = crypto.createHash('sha256').update(Buffer.concat([U8('1'), U8('415'), x.pub, encKey])).digest(); const enc = layout(okm.subarray(0, 24), comp, h2); return { temp: { e: x.e, okm, comp }, wire: Buffer.concat([pbv(1, 1), pbl(2, Buffer.concat([pbv(1, 415), pbl(2, x.pub)])), pbl(3, encKey), pbl(4, Buffer.alloc(0)), pbl(5, enc)]) }; }
function requiredField(fields: Map<number, Buffer | bigint>, field: number, name: string): Buffer {
    const value = fields.get(field);
    if (!Buffer.isBuffer(value)) throw new Error(`${name} is missing (fields: ${[...fields.keys()].join(',') || 'none'})`);
    return value;
}
function parseManual(body: Buffer, temp: any) {
    let hybridResponse: Buffer | undefined;
    try {
        const offset = readWpkg(body);
        if (offset < body.length && body[offset] === 0x0A) hybridResponse = body.subarray(offset);
    } catch {}
    if (!hybridResponse) {
        const marker = Buffer.from([0x08, 0x9F, 0x03, 0x12, 0x41, 0x04]);
        const offset = body.indexOf(marker);
        if (offset < 2) throw new Error('HybridEcdhResponse not found');
        hybridResponse = body.subarray(offset - 2);
    }
    const response = pbf(hybridResponse);
    const keyFields = pbf(requiredField(response, 1, 'HybridEcdhResponse field 1'));
    const peer = requiredField(keyFields, 2, 'HybridEcdhResponse server public key');
    const ct = requiredField(response, 3, 'HybridEcdhResponse ciphertext');
    const cred = Number(response.get(2) || 1n);
    const secret = crypto.createHash('sha256').update(temp.e.computeSecret(peer)).digest();
    const aad = crypto.createHash('sha256').update(Buffer.concat([temp.okm.subarray(24), temp.comp, U8('415'), peer, U8(String(cred))])).digest();
    const plain = lz4(unlayout(secret.subarray(0, 24), ct, aad));
    const manual = pbf(plain);
    const bodyFields = pbf(requiredField(manual, 3, 'ManualAuthResponse field 3'));
    if (!Buffer.isBuffer(bodyFields.get(2))) {
        const code = bodyFields.get(4);
        const message = bodyFields.get(5);
        const detail = Buffer.isBuffer(message) ? message.toString('utf8') : 'unknown error';
        throw new Error(`ManualAuth rejected: code=${typeof code === 'bigint' ? code : 'unknown'} message=${detail}`);
    }
    const sessionFields = pbf(requiredField(bodyFields, 2, 'ManualAuthResponse session block'));
    const identityFields = pbf(requiredField(bodyFields, 3, 'ManualAuthResponse identity block'));
    return {
        sendKey: requiredField(sessionFields, 1, 'ManualAuthResponse send key'),
        recvKey: requiredField(sessionFields, 2, 'ManualAuthResponse receive key'),
        f9: Buffer.isBuffer(sessionFields.get(9)) ? sessionFields.get(9) as Buffer : Buffer.alloc(0),
        uin: identityFields.get(1) as bigint,
    };
}
function jsPlain(uin: bigint, appId: string, host: Buffer) { const mac = crypto.randomBytes(6); mac[0] = (mac[0] | 0x02) & 0xFE; const dev = U8(mac.toString('hex').match(/../g)!.join('-').toUpperCase()); const uin32 = BigInt.asUintN(32, uin); const info = (name: string) => Buffer.concat([pbl(1, U8('sessionkey')), pbv(2, uin32), pbl(3, dev), pbv(4, 1661404927), pbl(5, U8(name)), pbv(6, 0)]); const req = Buffer.concat([pbl(1, info('UnifiedPCWindows')), pbl(2, U8(appId)), pbv(4, 1), pbl(5, Buffer.alloc(0)), pbl(6, Buffer.alloc(0)), pbv(7, 1)]); return Buffer.concat([pbl(1, info('Windows')), pbl(2, U8('/cgi-bin/mmbiz-bin/js-login')), pbl(3, host), pbv(4, 5), pbl(5, req), pbl(6, U8(appId)), pbv(7, 1029), pbv(8, 1610627409), pbl(9, U8('WindowsxWebPlugin')), pbv(10, 573651281)]); }
function envelope(s: Session, plain: Buffer) { const enc = layout(s.sendKey, lz4Literal(plain)); const head = wpkg({ 1: 1, 2: s.uin, 3: 0, 4: 0, 5: 524545, 6: 11, 7: 0, 8: 0, 9: 0, 10: 1, 11: 0, 12: 0, 13: 0, 17: 0, 18: 1, 20: 1504, 21: 0, 22: s.uin, 23: 0, 25: 16, 26: 4, 28: 1, 29: 1, 30: 0 }, { 14: Buffer.alloc(0), 24: s.deviceId, 27: s.f9 }); const inner = short(0x0B41, 0, Buffer.concat([head, enc])); const b = Buffer.concat([Buffer.alloc(2), TRANSFER_PATH, Buffer.alloc(2), TRANSFER_HOST, Buffer.alloc(4), inner]); b.writeUInt16BE(TRANSFER_PATH.length); b.writeUInt16BE(TRANSFER_HOST.length, 2 + TRANSFER_PATH.length); b.writeUInt32BE(inner.length, 4 + TRANSFER_PATH.length + TRANSFER_HOST.length); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); }
/**
 * 解析 wx.login 的 JSLoginResponse。
 *
 * 结构（对应 YYB-Go-Enhanced 的 login_code_response.go）：
 *   外层 field 2 = JSLoginResponse
 *     ├─ field 1 = BaseResponse（其 field 1 = ret）
 *     ├─ field 2 = JSAPI Result（其 field 1 = ret）
 *     └─ field 3 = code
 *
 * 业务拒绝必须优先判断：ret 非 0 时即使响应里同时带了 code 形状的字段，
 * 也以拒绝为准 —— `-14` 就是从这里出来的，早期实现只找 code、找不到就报
 * 「解密失败」，于是把「AppID 拒绝」误当成「会话失效」去重新登录。
 */
function loginCodeFromPlain(plain: Buffer): string | null {
    const outer = pbf(plain);
    const inner = pbf(requiredField(outer, 2, 'wx.login response field 2'));
    for (const field of [1, 2]) {
        const block = inner.get(field);
        if (!Buffer.isBuffer(block)) continue;
        const ret = pbf(block).get(1);
        if (typeof ret === 'bigint' && ret !== 0n) {
            const stage = field === 1 ? 'jslogin_business' : 'jslogin_result';
            // ret 在线上是 varint（负数按 64 位补码传），读回来要按 int32 还原，
            // 否则 -14 会被打印成 18446744073709551602，后面的分类就对不上了。
            throw new Error(`wx.login ${stage} rejected: code=${Number(BigInt.asIntN(32, ret))}`);
        }
    }
    const code = inner.get(3);
    if (Buffer.isBuffer(code) && code.length) return code.toString();
    return null;
}

/** 报文里的业务拒绝是确定结论：换接入点、换会话重试都只是重复被拒。 */
function isBusinessRejection(error: any): boolean {
    return /rejected: code=/.test(String((error && error.message) || ''));
}

/** 在已建立的会话上请求一次 wx.login；复用会话时不会产生新的 ManualAuth。 */
async function requestCodeOnSession(session: Session, appId: string, target: Target): Promise<string> {
    const env = envelope(session, jsPlain(session.uin, appId, session.hostAppId));
    const ts = Math.floor(Date.now() / 1000);
    const hello = pskClientHello(session.ticket, ts);
    const ek = oneWayKeys(session.psk, 'early data key expansion', crypto.createHash('sha256').update(hello).digest());
    const type8 = Buffer.from([0, 0, 0, 16, 8, 0, 0, 0, 11, 1, 0, 0, 0, 6, 0, 18, 0, 0, 0, 0]);
    type8.writeUInt32BE(ts, 16);
    const body = Buffer.concat([rec(0x19, hello), rec(0x19, gcm(ek.key, ek.iv, 1, 0x19, type8)), rec(0x17, gcm(ek.key, ek.iv, 2, 0x17, env)), rec(0x15, gcm(ek.key, ek.iv, 3, 0x15, Buffer.from([0, 0, 0, 3, 0, 1, 1])))]);
    const requestHead = `POST /mmtls/${ts.toString(16).padStart(8, '0')} HTTP/1.0\r\nAccept: */*\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: ${body.length}\r\nContent-Type: application/octet-stream\r\nHost: shortcloud.weixin.com\r\nUpgrade: mmtls\r\nUser-Agent: MicroMessenger Client\r\nX-Online-Host: shortcloud.weixin.com\r\n\r\n`;
    const c = await socket(target.host, target.port, 8000);
    const chunks: Buffer[] = [];
    c.s.on('data', chunk => chunks.push(Buffer.from(chunk)));
    try {
        await c.send(Buffer.concat([U8(requestHead), body]));
        // 8 秒兜底定时器原来从不清理；c.send 失败时 c.close() 也被整段跳过，
        // 泄漏一条 TCP 连接。两条都收进 finally。
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>((resolve) => {
                c.s.once('end', resolve);
                waitTimer = setTimeout(resolve, 8000);
            });
        } finally {
            if (waitTimer) clearTimeout(waitTimer);
        }
    } finally {
        c.close();
    }
    const raw = Buffer.concat(chunks);
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('ShortLink returned an invalid HTTP response');
    const responseRecords = records(raw.subarray(headerEnd + 4));
    const serverHello = responseRecords.find(record => record.type === 0x16)?.body;
    const appData = responseRecords.find(record => record.type === 0x17)?.body;
    if (!serverHello || !appData) throw new Error('ShortLink response missing ServerHello/AppData');
    const transcripts = [Buffer.concat([hello, serverHello]), Buffer.concat([hello, type8, serverHello]), Buffer.concat([hello, serverHello, type8])];
    for (const transcript of transcripts) {
        const hk = oneWayKeys(session.psk, 'handshake key expansion', crypto.createHash('sha256').update(transcript).digest());
        for (const seq of [2, 1, 3]) {
            try {
                const decrypted = gcm(hk.key, hk.iv, seq, 0x17, appData, true);
                const candidates: Buffer[] = [decrypted];
                try { candidates.unshift(parseShort(decrypted).body); } catch {}
                for (const candidate of candidates) {
                    for (let offset = 0; offset < Math.min(220, candidate.length); offset++) {
                        try {
                            const plain = lz4(unlayout(session.recvKey, candidate.subarray(offset)));
                            const code = loginCodeFromPlain(plain);
                            if (code) return code;
                        } catch (error: any) {
                            // 业务拒绝是确定结论，不能被后面的 offset 尝试掩盖掉。
                            if (isBusinessRejection(error)) throw error;
                        }
                    }
                }
            } catch (error: any) {
                if (isBusinessRejection(error)) throw error;
            }
        }
    }
    throw new Error('ShortLink AppData decrypt/parse failed');
}

/** 依次尝试短链接入点；业务拒绝直接抛给上层分类，不做无意义的换点重试。 */
async function tryShortTargets(session: Session, appId: string): Promise<string> {
    const failures: string[] = [];
    for (const target of await resolveTargets('short')) {
        try {
            return await requestCodeOnSession(session, appId, target);
        } catch (error: any) {
            if (isBusinessRejection(error)) throw error;
            failures.push(`${target.host}:${target.port} ${String((error && error.message) || error).slice(0, 120)}`);
        }
    }
    throw new Error(`Unable to request wx.login code: ${failures.join('; ') || 'no HTTPDNS target available'}`);
}

/** 完整握手：长链 mmtls + ManualAuth，拿到可复用的会话密钥。 */
async function establishSession(loginBuffer: string): Promise<Session> {
    const { req, device, host } = manualRequest(loginBuffer, crypto.randomBytes(32));
    const failures: string[] = [];
    for (const target of (await resolveTargets('long')).slice(0, 8)) {
        let c: any = null;
        try {
            c = await socket(target.host, target.port);
            const a = ecdh(); const b = ecdh(); const hello = ch(a.pub, b.pub);
            await c.send(rec(0x16, hello));
            const sh = await c.take();
            const serverHello = splitHs(sh.body).body;
            const extLength = serverHello.readUInt32BE(36);
            const ext = serverHello.subarray(40, 40 + extLength);
            if (ext.length < 78 || ext[0] !== 0x01) throw new Error('invalid ServerHello key-share extension');
            const secret = crypto.createHash('sha256').update(a.e.computeSecret(ext.subarray(13, 78))).digest();
            const transcript: Buffer[] = [hello, sh.body];
            const hsKeys = keys(secret, 'handshake key expansion', crypto.createHash('sha256').update(Buffer.concat(transcript)).digest());
            let certHash: Buffer | undefined; const ticketEntries: Buffer[] = [];
            // ServerHello is the first received MMTLS record, so encrypted records
            // continue at sequence 1. The sequence also continues into AppData.
            let rxSeq = 1;
            for (;;) {
                const r = await c.take(); const plain = gcm(hsKeys.sk, hsKeys.si, rxSeq++, r.type, r.body, true); const x = splitHs(plain);
                if (x.type !== 0x14) transcript.push(plain);
                if (x.type === 0x0F) certHash = crypto.createHash('sha256').update(Buffer.concat(transcript)).digest();
                if (x.type === 0x04) { let o = 1; for (let i = 0; i < x.body[0]; i++) { const n = x.body.readUInt32BE(o); const e = x.body.subarray(o + 4, o + 4 + n); o += 4 + n; ticketEntries.push(e); } }
                if (x.type === 0x14) {
                    const hash = crypto.createHash('sha256').update(Buffer.concat(transcript)).digest();
                    const verify = hmac(expand(secret, 'server finished', Buffer.alloc(0), 32), hash);
                    if (!x.body.subarray(2).equals(verify)) throw new Error('MMTLS server verification failed');
                    const appKeys = keys(expand(secret, 'expanded secret', hash, 32), 'application data key expansion', hash);
                    const finish = hs(0x14, Buffer.concat([Buffer.from([0, 32]), hmac(expand(secret, 'client finished', Buffer.alloc(0), 32), hash)]));
                    await c.send(rec(0x16, gcm(hsKeys.ck, hsKeys.ci, 1, 0x16, finish)));
                    const h = hybrid(req);
                    const body = Buffer.concat([wpkg({ 1:1,2:0,3:0,4:0,5:524545,6:11,7:0,8:0,9:0,10:1,11:0,12:0,13:0,17:0,18:1,20:1504,21:0,22:0,23:0,25:17,26:4,28:1,29:1,30:0 }, {14:Buffer.alloc(0),24:device,27:Buffer.alloc(0)}), h.wire]);
                    await c.send(rec(0x17, gcm(appKeys.ck, appKeys.ci, 2, 0x17, short(0x0D7D, 0, body))));
                    const ar = await c.take(); const auth = parseShort(gcm(appKeys.sk, appKeys.si, rxSeq++, ar.type, ar.body, true)); const s = parseManual(auth.body, h.temp);
                    const tickets = certHash ? ticketEntries.filter(entry => entry[0] === 1).map(ticket => ({ psk: expand(secret, 'PSK_ACCESS', certHash!, 32), ticket })) : [];
                    if (!s.sendKey || !s.recvKey || !s.uin || !tickets.length) throw new Error('ManualAuth did not return a usable session');
                    const established: Session = { ...s, deviceId: device, hostAppId: host, ...tickets[0] };
                    return established;
                }
            }
        } catch (error: any) {
            failures.push(`${target.host}:${target.port} ${String((error && error.message) || error).slice(0, 120)}`);
        } finally {
            // 握手中间任一步失败时，原来 try 内局部的 c 没有人关；最多 8 个接入点
            // 逐个重试会泄漏 8 条 TCP 连接及其 data/end 监听器。
            if (c) c.close();
        }
    }
    throw new Error(`Unable to establish WeChat protocol session: ${failures.join('; ') || 'no HTTPDNS target succeeded'}`);
}

/**
 * 取一次游戏登录 Code。
 *
 * 两条路径：
 *   1. 会话缓存命中（20 分钟内换过）→ 直接用缓存的 PSK/ticket 走短链 early data，
 *      跳过整个长链握手与 ManualAuth。这条路径不消耗登录预算，也不会在授权层
 *      留下新的登录记录 —— 这正是 YYB-Go-Enhanced 反复强调的关键。
 *   2. 未命中 → 完整握手。这一步要新建 ticket + ManualAuth，按账号走登录预算
 *      （10 分钟 3 次），避免业务流量把 OAuth 层打爆。
 */
export async function getNativeWxLoginCode(loginBuffer: string, appId: string, options: { accountId?: string } = {}): Promise<string> {
    const cacheKey = sessionCacheKey(loginBuffer, appId);

    const cached = getCachedSession(cacheKey);
    if (cached) {
        try {
            return await tryShortTargets(cached, appId);
        } catch (error: any) {
            if (isBusinessRejection(error)) throw error;
            // 会话可能已被服务端回收，退回完整握手再试一次。
            invalidateCachedSession(cacheKey);
        }
    }

    const accountId = String(options.accountId || '');
    if (accountId) {
        const budget = loginBudget.take(accountId);
        if (!budget.allowed) {
            throw new Error(`登录预算已用尽（${Math.round(loginBudget.windowMs / 60000)} 分钟内已登录 ${budget.used} 次）：${Math.ceil(budget.retryAfterMs / 1000)} 秒后自动恢复，本次不再打上游`);
        }
    }

    const session = await establishSession(loginBuffer);
    setCachedSession(cacheKey, session);
    try {
        return await tryShortTargets(session, appId);
    } catch (error: any) {
        if (!isBusinessRejection(error)) invalidateCachedSession(cacheKey);
        throw error;
    }
}

/**
 * 仅导出给单测：解析 wx.login 的 JSLoginResponse。
 * 这是纯函数，不含网络与状态，单独测能覆盖 -14 这类「业务拒绝优先于 code」的分支。
 */
export function parseLoginCodeResponse(plain: Buffer): string | null {
    return loginCodeFromPlain(plain);
}
