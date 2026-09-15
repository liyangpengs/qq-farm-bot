// @ts-nocheck
export {};
/**
 * 抓包服务 CA 与站点证书管理（基于 node-forge）
 *
 * - 首次启动生成根 CA（RSA 2048，有效期 10 年），持久化到 <dataDir>/capture/ca/
 * - 为每个需要中间人的域名签发站点证书（有效期 1 年），内存缓存 SecureContext
 * - 提供 DER 格式 .cer 供 iOS/Android 安装信任
 *
 * 安全提示：根 CA 被手机信任后，可解密该手机经代理的所有流量，
 * 仅应在受信任网络与自己的设备上启用。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const forge = require('node-forge');

const CA_CN = 'QQFarmCaptureRootCA';
const CA_ORG = 'QQFarmCapture';
const CA_DAYS = 3650;
const LEAF_DAYS = 365;

const contextCache = new Map();

function getCaDir(dataDir) {
  return path.join(dataDir, 'capture', 'ca');
}

function randomSerial() {
  return crypto.randomBytes(16).toString('hex');
}

function buildSubject(attrs) {
  return attrs || [
    { name: 'organizationName', value: CA_ORG },
    { name: 'commonName', value: CA_CN },
  ];
}

/** 创建自签名根 CA */
function createRootCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 24 * 3600 * 1000);

  cert.setSubject(buildSubject());
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
    key: keys.privateKey,
    cert,
  };
}

/** 加载或创建并持久化根 CA */
function loadOrCreateRootCa(dataDir) {
  const caDir = getCaDir(dataDir);
  const keyPath = path.join(caDir, 'ca.key');
  const certPath = path.join(caDir, 'ca.crt');

  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const keyPem = fs.readFileSync(keyPath, 'utf8');
      const certPem = fs.readFileSync(certPath, 'utf8');
      const key = forge.pki.privateKeyFromPem(keyPem);
      const cert = forge.pki.certificateFromPem(certPem);
      return { keyPem, certPem, key, cert, keyPath, certPath };
    }
  } catch {
    // 证书文件损坏时重新生成
  }

  const created = createRootCa();
  fs.mkdirSync(caDir, { recursive: true });
  fs.writeFileSync(keyPath, created.keyPem, 'utf8');
  fs.writeFileSync(certPath, created.certPem, 'utf8');
  return { ...created, keyPath, certPath };
}

/**
 * 为指定域名签发站点证书（返回 PEM）
 * @param {import('node-forge').pki.Certificate} caCert
 * @param {import('node-forge').pki.PrivateKey} caKey
 * @param {string} host
 */
function issueLeafCert(caCert, caKey, host) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 3600 * 1000);

  cert.setSubject([
    { name: 'organizationName', value: CA_ORG },
    { name: 'commonName', value: host },
  ]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = [{ type: 2, value: host }];
  const parentDomain = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '';
  if (parentDomain && parentDomain.includes('.') && parentDomain !== host) {
    altNames.push({ type: 2, value: `*.${parentDomain}` });
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

/** 获取（并缓存）指定域名的 TLS SecureContext */
function getSecureContextForHost(ca, host) {
  const cached = contextCache.get(host);
  if (cached) return cached;

  const { keyPem, certPem } = issueLeafCert(ca.cert, ca.key, host);
  const context = tls.createSecureContext({ key: keyPem, cert: certPem });
  contextCache.set(host, context);
  return context;
}

/** 根 CA 证书的 DER 字节（.cer 下载用） */
function getCaCertDer(ca) {
  const asn1 = forge.pki.certificateToAsn1(ca.cert);
  const der = forge.asn1.toDer(asn1).getBytes();
  return Buffer.from(der, 'binary');
}

/** 清理缓存（测试用） */
function clearContextCache() {
  contextCache.clear();
}

module.exports = {
  CA_CN,
  clearContextCache,
  createRootCa,
  getCaCertDer,
  getCaDir,
  getSecureContextForHost,
  issueLeafCert,
  loadOrCreateRootCa,
};
