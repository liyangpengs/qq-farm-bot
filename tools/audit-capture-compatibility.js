/*
 * Audits captured gateway messages against the local protobuf definitions.
 * Usage: pnpm -C core exec tsx ../tools/audit-capture-compatibility.js <capture-dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');
const cryptoWasm = require('../core/src/utils/crypto-wasm.ts');

const captureDir = path.resolve(process.argv[2] || 'C:/Users/liyp/Downloads/protocol');
const protoDir = path.resolve(__dirname, '../core/src/proto');

const rpcTypes = {
    'gamepb.userpb.UserService.Login': ['gamepb.userpb.LoginRequest', 'gamepb.userpb.LoginReply'],
    'gamepb.userpb.UserService.GetUserSettings': ['gamepb.userpb.GetUserSettingsRequest', 'gamepb.userpb.GetUserSettingsReply'],
    'gamepb.userpb.UserService.SetDisplayInfo': ['gamepb.userpb.SetDisplayInfoRequest', 'gamepb.userpb.SetDisplayInfoReply'],
    'gamepb.userpb.UserService.BatchClientReportFlow': ['gamepb.userpb.BatchClientReportFlowRequest', 'gamepb.userpb.BatchClientReportFlowReply'],
    'gamepb.userpb.UserService.Heartbeat': ['gamepb.userpb.HeartbeatRequest', 'gamepb.userpb.HeartbeatReply'],
    'gamepb.mysteryshoppb.MysteryShopService.GetActiveNPC': ['gamepb.mysteryshoppb.GetActiveNPCRequest', 'gamepb.mysteryshoppb.GetActiveNPCReply'],
    'gamepb.friendpb.FriendService.GetShareKey': ['gamepb.friendpb.GetShareKeyRequest', 'gamepb.friendpb.GetShareKeyReply'],
    'gamepb.friendpb.FriendService.SyncAll': ['gamepb.friendpb.SyncAllRequest', 'gamepb.friendpb.SyncAllReply'],
    'gamepb.qqvippb.QQVipService.GetQQVipRewardsStatus': ['gamepb.qqvippb.GetQQVipRewardsStatusRequest', 'gamepb.qqvippb.GetQQVipRewardsStatusReply'],
    'gamepb.qqvippb.QQVipService.RefreshVipInfo': ['gamepb.qqvippb.RefreshVipInfoRequest', 'gamepb.qqvippb.RefreshVipInfoReply'],
    'gamepb.qqvippb.QQVipService.ClaimQQVipRewards': ['gamepb.qqvippb.ClaimQQVipRewardsRequest', 'gamepb.qqvippb.ClaimQQVipRewardsReply'],
    'gamepb.uicproxypb.UicprotoxyService.BatchModerateText': ['gamepb.uicproxypb.BatchModerateTextRequest', 'gamepb.uicproxypb.BatchModerateTextReply'],
    'gamepb.acepb.AceService.AntiData': ['gamepb.acepb.AntiDataRequest', 'gamepb.acepb.AntiDataReply'],
    'gamepb.plantpb.PlantService.AllLands': ['gamepb.plantpb.AllLandsRequest', 'gamepb.plantpb.AllLandsReply'],
    'gamepb.illustratedpb.IllustratedService.GetIllustratedListV2': ['gamepb.illustratedpb.GetIllustratedListV2Request', 'gamepb.illustratedpb.GetIllustratedListV2Reply'],
    'gamepb.illustratedpb.IllustratedService.GetIllustratedLevelListV2': ['gamepb.illustratedpb.GetIllustratedLevelListV2Request', 'gamepb.illustratedpb.GetIllustratedLevelListV2Reply'],
    'gamepb.illustratedpb.IllustratedService.ClearNewUnlockedFruitsV2': ['gamepb.illustratedpb.ClearNewUnlockedFruitsV2Request', 'gamepb.illustratedpb.ClearNewUnlockedFruitsV2Reply'],
    'gamepb.dogpb.DogService.GetDogInfo': ['gamepb.dogpb.GetDogInfoRequest', 'gamepb.dogpb.GetDogInfoReply'],
    'gamepb.dogpb.DogService.DeployDog': ['gamepb.dogpb.DeployDogRequest', 'gamepb.dogpb.DeployDogReply'],
    'gamepb.dogpb.DogService.WithdrawDog': ['gamepb.dogpb.WithdrawDogRequest', 'gamepb.dogpb.WithdrawDogReply'],
    'gamepb.dogpb.DogService.AddFood': ['gamepb.dogpb.AddFoodRequest', 'gamepb.dogpb.AddFoodReply'],
    'gamepb.dogpb.DogService.GetProtectLogs': ['gamepb.dogpb.GetProtectLogsRequest', 'gamepb.dogpb.GetProtectLogsReply'],
    'gamepb.taskpb.TaskService.TaskInfo': ['gamepb.taskpb.TaskInfoRequest', 'gamepb.taskpb.TaskInfoReply'],
    'gamepb.skinpb.SkinService.SkinsOwned': ['gamepb.skinpb.SkinsOwnedRequest', 'gamepb.skinpb.SkinsOwnedReply'],
    'gamepb.skinpb.SkinService.SkinsEquipped': ['gamepb.skinpb.SkinsEquippedRequest', 'gamepb.skinpb.SkinsEquippedReply'],
    'gamepb.skinpb.SkinService.GetSkinEffectTypeParams': ['gamepb.skinpb.GetSkinEffectTypeParamsRequest', 'gamepb.skinpb.GetSkinEffectTypeParamsReply'],
    'gamepb.activitypb.ActivityService.List': ['gamepb.activitypb.ActivityListRequest', 'gamepb.activitypb.ActivityListReply'],
    'gamepb.activitypb.ActivityService.SetSplashed': ['gamepb.activitypb.SetSplashedRequest', 'gamepb.activitypb.SetSplashedReply'],
    'gamepb.activitypb.ActivityService.GetGroup': ['gamepb.activitypb.GetGroupRequest', 'gamepb.activitypb.GetGroupReply'],
    'gamepb.seasonpb.SeasonService.GetSeasonInfo': ['gamepb.seasonpb.GetSeasonInfoRequest', 'gamepb.seasonpb.GetSeasonInfoReply'],
    'gamepb.solartermspb.SolarTermsService.GetSolarTermsRedDot': ['gamepb.solartermspb.GetSolarTermsRedDotRequest', 'gamepb.solartermspb.GetSolarTermsRedDotReply'],
    'gamepb.emailpb.EmailService.GetEmailList': ['gamepb.emailpb.GetEmailListRequest', 'gamepb.emailpb.GetEmailListReply'],
    'gamepb.emailpb.EmailService.BatchClaimEmail': ['gamepb.emailpb.BatchClaimEmailRequest', null],
    'gamepb.emailpb.EmailService.BatchDeleteEmail': ['gamepb.emailpb.BatchDeleteEmailRequest', 'gamepb.emailpb.BatchDeleteEmailReply'],
    'gamepb.sharepb.ShareService.GetInviteInfo': ['gamepb.sharepb.GetInviteInfoRequest', 'gamepb.sharepb.GetInviteInfoReply'],
    'gamepb.paypb.PayService.GetRechargeInfo': ['gamepb.paypb.GetRechargeInfoRequest', 'gamepb.paypb.GetRechargeInfoReply'],
    'gamepb.bulletinboardpb.BulletinBoardService.GetBulletinList': ['gamepb.bulletinboardpb.GetBulletinListRequest', 'gamepb.bulletinboardpb.GetBulletinListReply'],
    'gamepb.bulletinboardpb.BulletinBoardService.GetBulletinDetail': ['gamepb.bulletinboardpb.GetBulletinDetailRequest', 'gamepb.bulletinboardpb.GetBulletinDetailReply'],
    'gamepb.redpacketpb.RedPacketService.GetTodayClaimStatus': ['gamepb.redpacketpb.GetTodayClaimStatusRequest', 'gamepb.redpacketpb.GetTodayClaimStatusReply'],
    'gamepb.marqueepb.MarqueeService.GetMarquee': ['gamepb.marqueepb.GetMarqueeRequest', 'gamepb.marqueepb.GetMarqueeReply'],
    'gamepb.avatarframepb.AvatarFrameService.AvatarFramesOwned': ['gamepb.avatarframepb.AvatarFramesOwnedRequest', 'gamepb.avatarframepb.AvatarFramesOwnedReply'],
    'gamepb.rechargebonuspb.RechargeBonusService.GetConfig': ['gamepb.rechargebonuspb.GetConfigRequest', 'gamepb.rechargebonuspb.GetConfigReply'],
    'gamepb.miscpb.MiscService.GetFollowGiftStatus': ['gamepb.miscpb.GetFollowGiftStatusRequest', 'gamepb.miscpb.GetFollowGiftStatusReply'],
    'gamepb.mallpb.MallService.GetMallListBySlotType': ['gamepb.mallpb.GetMallListBySlotTypeRequest', 'gamepb.mallpb.GetMallListBySlotTypeResponse'],
    'gamepb.shoppb.ShopService.ShopInfo': ['gamepb.shoppb.ShopInfoRequest', 'gamepb.shoppb.ShopInfoReply'],
    'gamepb.itempb.ItemService.Bag': ['gamepb.itempb.BagRequest', 'gamepb.itempb.BagReply'],
    'gamepb.interactpb.InteractService.GetInteractInfo': ['gamepb.interactpb.GetInteractInfoRequest', 'gamepb.interactpb.GetInteractInfoReply'],
};

const scalarWires = {
    double: 1,
    float: 5,
    int32: 0,
    uint32: 0,
    sint32: 0,
    fixed32: 5,
    sfixed32: 5,
    int64: 0,
    uint64: 0,
    sint64: 0,
    fixed64: 1,
    sfixed64: 1,
    bool: 0,
    string: 2,
    bytes: 2,
};

function skip(reader, wire) {
    if (wire === 0) reader.uint64();
    else if (wire === 1) reader.skip(8);
    else if (wire === 2) reader.bytes();
    else if (wire === 5) reader.skip(4);
    else throw new Error(`unsupported wire type ${wire}`);
}

function auditMessage(type, buffer, location, issues) {
    const reader = protobuf.Reader.create(buffer);
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const fieldId = tag >>> 3;
        const wire = tag & 7;
        const field = type.fieldsById[fieldId];
        if (!field) {
            issues.add(`${location}: unknown field ${fieldId} (wire ${wire})`);
            skip(reader, wire);
            continue;
        }

        const resolved = field.resolve().resolvedType;
        const expectedWire = resolved instanceof protobuf.Type
            ? 2
            : (resolved instanceof protobuf.Enum ? 0 : scalarWires[field.type]);
        const packed = field.repeated && field.packed !== false && expectedWire !== 2;
        if (wire !== expectedWire && !(packed && wire === 2)) {
            issues.add(`${location}.${field.name}: wire ${wire}, expected ${expectedWire}`);
            skip(reader, wire);
            continue;
        }

        if (wire === 2) {
            const bytes = Buffer.from(reader.bytes());
            if (field.map) {
                continue;
            }
            if (resolved instanceof protobuf.Type) {
                auditMessage(resolved, bytes, `${location}.${field.name}`, issues);
            }
        } else {
            skip(reader, wire);
        }
    }
}

async function main() {
    const root = new protobuf.Root();
    const protoFiles = fs.readdirSync(protoDir)
        .filter((name) => name.endsWith('.proto'))
        .map((name) => path.join(protoDir, name));
    await root.load(protoFiles, { keepCase: true });

    const gateType = root.lookupType('gatepb.Message');
    const eventType = root.lookupType('gatepb.EventMessage');
    const issues = new Set();
    const audited = new Set();
    let frames = 0;

    for (const name of fs.readdirSync(captureDir).filter((item) => item.endsWith('.bin')).sort()) {
        let message;
        try {
            message = gateType.decode(fs.readFileSync(path.join(captureDir, name)));
        } catch {
            continue;
        }
        const meta = message.meta || {};
        const messageType = Number(meta.message_type);
        let body = Buffer.from(message.body || []);
        if (messageType === 1 && body.length) body = await cryptoWasm.decryptBuffer(body);

        if (messageType === 3) {
            let event;
            try {
                event = eventType.decode(body);
            } catch (error) {
                issues.add(`${name}: invalid EventMessage: ${error.message}`);
                continue;
            }
            const eventName = String(event.message_type || '');
            let notifyType;
            try {
                notifyType = root.lookupType(eventName);
            } catch {
                issues.add(`${name}: missing notify type ${eventName}`);
                continue;
            }
            auditMessage(notifyType, Buffer.from(event.body || []), eventName, issues);
            audited.add(eventName);
            frames += 1;
            continue;
        }

        if (messageType !== 1 && messageType !== 2) continue;
        const key = `${meta.service_name || ''}.${meta.method_name || ''}`;
        const pair = rpcTypes[key];
        if (!pair) {
            issues.add(`${name}: missing RPC mapping ${key}`);
            continue;
        }
        const typeName = pair[messageType - 1];
        if (!typeName) {
            issues.add(`${name}: unexpected response for no-reply RPC ${key}`);
            continue;
        }
        const type = root.lookupType(typeName);
        auditMessage(type, body, typeName, issues);
        audited.add(key);
        frames += 1;
    }

    console.log(`Audited ${frames} protocol frames across ${audited.size} RPC/notify types.`);
    if (issues.size) {
        for (const issue of [...issues].sort()) console.error(issue);
        process.exitCode = 1;
        return;
    }
    console.log('No unknown fields, wire mismatches, or missing message types found.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
