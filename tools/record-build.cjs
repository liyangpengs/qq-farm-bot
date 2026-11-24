const fs = require('node:fs');

// Host and backend ship from core, but only part of core runs in the connection service.
const host = process.argv[2] === 'host';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(host ? 'dist/host-fingerprint' : 'dist/build-fingerprint', process.env.TURBO_HASH || '');
if (!host && !process.env.TURBO_HASH) fs.rmSync('dist/host-fingerprint', { force: true });
