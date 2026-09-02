/*
 * Extract the non-account-specific "雨落成诗" ActivityService.List subtree
 * from a protocol-capture session while retaining unknown protobuf fields.
 *
 * Usage:
 *   node tools/analyze-weather-bottle-capture.js <capture-dir> [--latest]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');

const captureDir = path.resolve(process.argv[2] || '.');
const latestOnly = process.argv.slice(3).includes('--latest');
const protoDir = path.resolve(__dirname, '../core/src/proto');
const protoFiles = fs.readdirSync(protoDir)
    .filter((name) => name.endsWith('.proto'))
    .map((name) => path.join(protoDir, name));

function scalar(value) {
    return typeof value === 'bigint' ? value.toString() : String(value);
}

function printableText(buffer) {
    const text = buffer.toString('utf8');
    if (!text || text.includes('\uFFFD')) return null;
    const chars = Array.from(text);
    const printable = chars.filter((char) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(char)).length;
    return printable / chars.length > 0.92 ? text : null;
}

function rawFields(buffer, depth = 0) {
    if (depth > 7) return { size: buffer.length };
    const reader = protobuf.Reader.create(buffer);
    const fields = [];
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field <= 0) throw new Error('invalid protobuf field');
        if (wire === 0) {
            fields.push({ field, wire, value: scalar(reader.uint64()) });
            continue;
        }
        if (wire === 1) {
            fields.push({ field, wire, value: reader.fixed64().toString() });
            continue;
        }
        if (wire === 5) {
            fields.push({ field, wire, value: reader.fixed32() });
            continue;
        }
        if (wire !== 2) throw new Error(`unsupported protobuf wire type ${wire}`);
        const value = Buffer.from(reader.bytes());
        const entry = { field, wire, size: value.length };
        const text = printableText(value);
        if (text !== null) entry.text = text;
        try {
            const nested = rawFields(value, depth + 1);
            if (nested.fields.length) entry.nested = nested.fields;
        } catch {}
        fields.push(entry);
    }
    return { fields };
}

function decodeExtra(value) {
    if (!value) return null;
    try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

function decodeActivityData(root, buffer) {
    const activityContent = root.lookupType('gamepb.activitypb.ActivityContent');
    const catalogType = root.lookupType('gamepb.activitypb.StarSandGoodsList');
    const bottleType = root.lookupType('gamepb.activitypb.WeatherBottleConfig');
    const tasksType = root.lookupType('gamepb.activitypb.WeatherActivityTasks');
    const researchType = root.lookupType('gamepb.activitypb.WeatherResearchData');
    const reader = protobuf.Reader.create(buffer);
    const node = { activity: null, children: [], known: {}, unknown: [] };
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (wire !== 2) {
            if (wire === 0) node.unknown.push({ field, wire, value: scalar(reader.uint64()) });
            else if (wire === 1) node.unknown.push({ field, wire, value: reader.fixed64().toString() });
            else if (wire === 5) node.unknown.push({ field, wire, value: reader.fixed32() });
            else throw new Error(`unsupported ActivityData wire type ${wire}`);
            continue;
        }
        const value = Buffer.from(reader.bytes());
        if (field === 1) {
            const decoded = activityContent.decode(value);
            node.activity = activityContent.toObject(decoded, { longs: String, bytes: String });
            node.activity.extra_json = decodeExtra(node.activity.extra);
            delete node.activity.extra;
        } else if (field === 2) {
            node.children.push(decodeActivityData(root, value));
        } else if (field === 102) {
            const decoded = catalogType.decode(value);
            node.known.catalog = catalogType.toObject(decoded, { longs: String, bytes: String });
        } else if (field === 105) {
            const decoded = bottleType.decode(value);
            node.known.weather_bottle = bottleType.toObject(decoded, { longs: String, bytes: String });
        } else if (field === 117) {
            const decoded = tasksType.decode(value);
            node.known.weather_tasks = tasksType.toObject(decoded, { longs: String, bytes: String });
        } else if (field === 118) {
            const decoded = researchType.decode(value);
            node.known.weather_research = researchType.toObject(decoded, { longs: String, bytes: String });
        } else {
            const entry = { field, wire, size: value.length };
            try { entry.raw = rawFields(value); } catch {}
            node.unknown.push(entry);
        }
    }
    if (!node.children.length) delete node.children;
    if (!Object.keys(node.known).length) delete node.known;
    if (!node.unknown.length) delete node.unknown;
    return node;
}

async function main() {
    const root = new protobuf.Root();
    await root.load(protoFiles, { keepCase: true });
    const gateType = root.lookupType('gatepb.Message');
    const files = fs.readdirSync(captureDir).filter((name) => name.endsWith('.bin')).sort();
    const matches = [];
    for (const file of files) {
        let gate;
        try {
            gate = gateType.decode(fs.readFileSync(path.join(captureDir, file)));
        } catch {
            continue;
        }
        const meta = gate.meta || {};
        if (Number(meta.message_type) !== 2
            || String(meta.service_name || '') !== 'gamepb.activitypb.ActivityService'
            || String(meta.method_name || '') !== 'List') continue;

        const reader = protobuf.Reader.create(Buffer.from(gate.body || []));
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (wire !== 2) throw new Error(`unexpected ActivityListReply wire type ${wire}`);
            const value = Buffer.from(reader.bytes());
            if (field !== 1) continue;
            const node = decodeActivityData(root, value);
            if (node.activity?.name === '雨落成诗') {
                matches.push({ source: file, weather_bottle: node });
                if (!latestOnly) {
                    console.log(JSON.stringify(matches[0], null, 2));
                    return;
                }
            }
        }
    }
    if (matches.length) {
        console.log(JSON.stringify(matches[matches.length - 1], null, 2));
        return;
    }
    throw new Error('No 雨落成诗 ActivityService.List response found');
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
