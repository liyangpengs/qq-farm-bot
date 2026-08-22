/*
 * Decode selected websocket captures and retain unknown protobuf fields.
 * Usage: pnpm -C core exec tsx ../tools/decode-latest-protocols.js <capture-dir> [method] [--shape]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');
const cryptoWasm = require('../core/src/utils/crypto-wasm.ts');

const captureDir = path.resolve(process.argv[2] || 'C:/Users/liyp/Downloads/协议');
const options = process.argv.slice(3);
const methodFilter = String(options.find(value => !value.startsWith('--')) || '');
const shapeOnly = options.includes('--shape');
const includeAllMethods = options.includes('--all');
const protoDir = path.resolve(__dirname, '../core/src/proto');
const protoFiles = fs.readdirSync(protoDir)
    .filter((name) => name.endsWith('.proto'))
    .map((name) => path.join(protoDir, name));

const selected = new Set([
    'gamepb.userpb.UserService.Login',
    'gamepb.userpb.UserService.Heartbeat',
    'gamepb.friendpb.FriendService.SyncAll',
    'gamepb.bulletinboardpb.BulletinBoardService.GetBulletinList',
    'gamepb.userpb.UserService.GetUserSettings',
    'gamepb.userpb.UserService.BatchClientReportFlow',
    'gamepb.uicproxypb.UicprotoxyService.BatchModerateText',
    'gamepb.qqvippb.QQVipService.GetQQVipRewardsStatus',
    'gamepb.qqvippb.QQVipService.RefreshVipInfo',
    'gamepb.qqvippb.QQVipService.ClaimQQVipRewards',
    'gamepb.emailpb.EmailService.GetEmailList',
    'gamepb.emailpb.EmailService.BatchClaimEmail',
    'gamepb.emailpb.EmailService.BatchDeleteEmail',
    'gamepb.avatarframepb.AvatarFrameService.AvatarFramesOwned',
    'gamepb.bulletinboardpb.BulletinBoardService.GetBulletinDetail',
    'gamepb.miscpb.MiscService.GetFollowGiftStatus',
    'gamepb.skinpb.SkinService.SkinsOwned',
    'gamepb.skinpb.SkinService.SkinsEquipped',
    'gamepb.skinpb.SkinService.GetSkinEffectTypeParams',
    'gamepb.interactpb.InteractService.GetInteractInfo',
    'gamepb.activitypb.ActivityService.SetSplashed',
    'gamepb.activitypb.ActivityService.GetGroup',
    'gamepb.activitypb.ActivityService.List',
    'gamepb.activitypb.ActivityService.Operate',
    'gamepb.itempb.ItemService.Bag',
    'gamepb.itempb.ItemService.Use',
    'gamepb.itempb.ItemService.BatchUse',
    'gamepb.dogpb.DogService.GetDogInfo',
    'gamepb.dogpb.DogService.DeployDog',
    'gamepb.dogpb.DogService.WithdrawDog',
    'gamepb.dogpb.DogService.AddFood',
    'gamepb.dogpb.DogService.GetProtectLogs',
    'gamepb.visitpb.VisitService.Enter',
    'gamepb.visitpb.VisitService.Leave',
    'gamepb.plantpb.PlantService.AllLands',
    'gamepb.plantpb.PlantService.Plant',
    'gamepb.taskpb.TaskService.TaskInfo',
    'gamepb.taskpb.TaskService.ClaimTaskReward',
    'gamepb.seasonpb.SeasonService.GetSeasonInfo',
]);

function scalar(value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

function printableText(buffer) {
    const text = buffer.toString('utf8');
    if (!text || text.includes('\uFFFD')) return null;
    const printable = Array.from(text).filter((char) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(char)).length;
    return printable / Array.from(text).length > 0.9 ? text : null;
}

function rawFields(buffer, depth = 0) {
    if (depth > 6) return { hex: buffer.toString('hex') };
    const reader = protobuf.Reader.create(buffer);
    const fields = [];
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (field <= 0) throw new Error('invalid field');
            if (wire === 0) {
                fields.push({ field, wire, value: scalar(reader.uint64()) });
            } else if (wire === 1) {
                fields.push({ field, wire, value: reader.fixed64().toString() });
            } else if (wire === 2) {
                const value = Buffer.from(reader.bytes());
                const entry = { field, wire, hex: value.toString('hex') };
                const text = printableText(value);
                if (text !== null) entry.text = text;
                try {
                    const nested = rawFields(value, depth + 1);
                    if (nested.fields && nested.fields.length) entry.nested = nested.fields;
                } catch {}
                fields.push(entry);
            } else if (wire === 5) {
                fields.push({ field, wire, value: reader.fixed32() });
            } else {
                throw new Error(`unsupported wire type ${wire}`);
            }
        }
    } catch (error) {
        if (depth === 0) return { error: error.message, hex: buffer.toString('hex') };
        throw error;
    }
    return { fields };
}

function wireShape(buffer) {
    const paths = new Map();

    function add(pathName, wire, value) {
        const key = `${pathName}:${wire}`;
        if (!paths.has(key)) paths.set(key, { path: pathName, wire, count: 0, samples: [] });
        const entry = paths.get(key);
        entry.count += 1;
        const sample = String(value);
        if (entry.samples.length < 4 && !entry.samples.includes(sample)) entry.samples.push(sample);
    }

    function visit(value, prefix = '', depth = 0) {
        if (depth > 7) return;
        const reader = protobuf.Reader.create(value);
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (field <= 0) throw new Error('invalid field');
            const fieldPath = prefix ? `${prefix}.${field}` : String(field);
            if (wire === 0) {
                add(fieldPath, wire, scalar(reader.uint64()));
            } else if (wire === 1) {
                add(fieldPath, wire, reader.fixed64().toString());
            } else if (wire === 2) {
                const bytes = Buffer.from(reader.bytes());
                const display = printableText(bytes);
                add(fieldPath, wire, display === null ? `bytes(${bytes.length})` : display.slice(0, 80));
                try {
                    visit(bytes, fieldPath, depth + 1);
                } catch {}
            } else if (wire === 5) {
                add(fieldPath, wire, reader.fixed32());
            } else {
                throw new Error(`unsupported wire type ${wire}`);
            }
        }
    }

    visit(buffer);
    return [...paths.values()];
}

function knownType(root, service, method, messageType) {
    const request = messageType === 1;
    const names = {
        'gamepb.activitypb.ActivityService.List': request ? 'gamepb.activitypb.ActivityListRequest' : 'gamepb.activitypb.ActivityListReply',
        'gamepb.activitypb.ActivityService.GetGroup': request ? 'gamepb.activitypb.GetGroupRequest' : 'gamepb.activitypb.GetGroupReply',
        'gamepb.itempb.ItemService.Bag': request ? 'gamepb.itempb.BagRequest' : 'gamepb.itempb.BagReply',
        'gamepb.itempb.ItemService.Use': request ? 'gamepb.itempb.UseRequest' : 'gamepb.itempb.UseReply',
        'gamepb.itempb.ItemService.BatchUse': request ? 'gamepb.itempb.BatchUseRequest' : 'gamepb.itempb.BatchUseReply',
        'gamepb.dogpb.DogService.GetDogInfo': request ? 'gamepb.dogpb.GetDogInfoRequest' : 'gamepb.dogpb.GetDogInfoReply',
        'gamepb.dogpb.DogService.DeployDog': request ? 'gamepb.dogpb.DeployDogRequest' : 'gamepb.dogpb.DeployDogReply',
        'gamepb.dogpb.DogService.WithdrawDog': request ? 'gamepb.dogpb.WithdrawDogRequest' : 'gamepb.dogpb.WithdrawDogReply',
        'gamepb.dogpb.DogService.AddFood': request ? 'gamepb.dogpb.AddFoodRequest' : 'gamepb.dogpb.AddFoodReply',
        'gamepb.dogpb.DogService.GetProtectLogs': request ? 'gamepb.dogpb.GetProtectLogsRequest' : 'gamepb.dogpb.GetProtectLogsReply',
        'gamepb.visitpb.VisitService.Enter': request ? 'gamepb.visitpb.EnterRequest' : 'gamepb.visitpb.EnterReply',
        'gamepb.visitpb.VisitService.Leave': request ? 'gamepb.visitpb.LeaveRequest' : 'gamepb.visitpb.LeaveReply',
        'gamepb.plantpb.PlantService.AllLands': request ? 'gamepb.plantpb.AllLandsRequest' : 'gamepb.plantpb.AllLandsReply',
        'gamepb.plantpb.PlantService.Plant': request ? 'gamepb.plantpb.PlantRequest' : 'gamepb.plantpb.PlantReply',
        'gamepb.taskpb.TaskService.TaskInfo': request ? 'gamepb.taskpb.TaskInfoRequest' : 'gamepb.taskpb.TaskInfoReply',
        'gamepb.taskpb.TaskService.ClaimTaskReward': request ? 'gamepb.taskpb.ClaimTaskRewardRequest' : 'gamepb.taskpb.ClaimTaskRewardReply',
        'gamepb.seasonpb.SeasonService.GetSeasonInfo': request ? 'gamepb.seasonpb.GetSeasonInfoRequest' : 'gamepb.seasonpb.GetSeasonInfoReply',
        'gamepb.illustratedpb.IllustratedService.GetIllustratedListV2': request ? 'gamepb.illustratedpb.GetIllustratedListV2Request' : 'gamepb.illustratedpb.GetIllustratedListV2Reply',
        'gamepb.illustratedpb.IllustratedService.GetIllustratedLevelListV2': request ? 'gamepb.illustratedpb.GetIllustratedLevelListV2Request' : 'gamepb.illustratedpb.GetIllustratedLevelListV2Reply',
        'gamepb.illustratedpb.IllustratedService.ClearNewUnlockedFruitsV2': request ? 'gamepb.illustratedpb.ClearNewUnlockedFruitsV2Request' : 'gamepb.illustratedpb.ClearNewUnlockedFruitsV2Reply',
        'gamepb.activitypb.ActivityService.Operate': request ? null : 'gamepb.activitypb.ActivityOperateReply',
    };
    const name = names[`${service}.${method}`];
    return name ? root.lookupType(name) : null;
}

async function main() {
    const root = new protobuf.Root();
    await root.load(protoFiles, { keepCase: true });
    const gate = root.lookupType('gatepb.Message');
    const eventType = root.lookupType('gatepb.EventMessage');
    const names = fs.readdirSync(captureDir).filter((name) => name.endsWith('.bin')).sort();
    for (const name of names) {
        let message;
        try {
            message = gate.decode(fs.readFileSync(path.join(captureDir, name)));
        } catch {
            continue;
        }
        const meta = message.meta || {};
        const messageType = Number(meta.message_type);
        if (messageType === 3) {
            const event = eventType.decode(Buffer.from(message.body || []));
            const eventName = String(event.message_type || '');
            if (methodFilter && eventName !== methodFilter && !eventName.endsWith(`.${methodFilter}`)) continue;
            const eventBody = Buffer.from(event.body || []);
            console.log(JSON.stringify({
                file: name,
                direction: 'NOTIFY',
                event: eventName,
                bodyHex: shapeOnly ? undefined : eventBody.toString('hex'),
                shape: shapeOnly ? wireShape(eventBody) : undefined,
            }));
            continue;
        }
        const service = String(meta.service_name || '');
        const method = String(meta.method_name || '');
        if (!includeAllMethods && !selected.has(`${service}.${method}`)) continue;
        if (methodFilter && method !== methodFilter) continue;

        let body = Buffer.from(message.body || []);
        if (messageType === 1 && body.length) body = await cryptoWasm.decryptBuffer(body);
        if (shapeOnly) {
            console.log(JSON.stringify({ file: name, direction: messageType === 1 ? 'SEND' : 'RECV', service, method, shape: wireShape(body) }));
            continue;
        }
        const type = knownType(root, service, method, messageType);
        let known = null;
        if (type) {
            try {
                const decoded = type.decode(body);
                known = type.toObject(decoded, { longs: String, enums: String, bytes: String });
            } catch (error) {
                known = { error: error.message };
            }
        }
        console.log(JSON.stringify({
            file: name,
            direction: messageType === 1 ? 'SEND' : 'RECV',
            service,
            method,
            clientSeq: scalar(meta.client_seq),
            errorCode: scalar(meta.error_code),
            errorMessage: String(meta.error_message || ''),
            bodyHex: body.toString('hex'),
            known,
            raw: rawFields(body),
        }));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
