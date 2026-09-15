export {};
/**
 * 好友 GID 提取器
 *
 * 服务器→客户端 WebSocket 消息为 `gatepb.Message`（protobuf），其中
 * `meta.service_name` / `meta.method_name` 标识 RPC，`body` 为明文
 * protobuf 回复体（与 bot 内直接解码的方式一致，无需 TSDK 解密）。
 *
 * 好友相关 RPC：
 * - gamepb.friendpb.FriendService.GetAll        → GetAllReply（完整列表）
 * - gamepb.friendpb.FriendService.SyncAll       → SyncAllReply（完整列表）
 * - gamepb.friendpb.FriendService.GetGameFriends→ GetAllReply 形态（分批）
 */

const path = require('node:path');
const protobuf = require('protobufjs');

const FRIEND_SERVICE = 'gamepb.friendpb.FriendService';
const COMPLETE_METHODS = new Set(['GetAll', 'SyncAll']);
const PARTIAL_METHODS = new Set(['GetGameFriends']);

const REPLY_TYPE_MAP = {
  GetAll: 'GetAllReply',
  SyncAll: 'SyncAllReply',
  GetGameFriends: 'GetAllReply',
};

function getProtoPaths() {
  // 返回 proto 文件绝对路径数组
  return [
    path.join(__dirname, '../proto/game.proto'),
    path.join(__dirname, '../proto/friendpb.proto'),
  ];
}

/**
 * 创建好友 GID 提取器（异步加载 proto）
 * @returns {Promise<{ handleMessage: (buffer: Buffer) => {gids: number[], source: string, complete: boolean} | null }>} 提取器实例
 */
async function createFriendExtractor() {
  const root = new protobuf.Root();
  await root.load(getProtoPaths(), { keepCase: true });

  const GateMessage = root.lookupType('gatepb.Message');
  const replyTypes = {};
  for (const [method, replyName] of Object.entries(REPLY_TYPE_MAP)) {
    try {
      replyTypes[method] = root.lookupType(`gamepb.friendpb.${replyName}`);
    } catch {
      replyTypes[method] = null;
    }
  }

  /**
   * 解析一条服务器→客户端的二进制 WebSocket 消息。
   * @param {Buffer} buffer
   * @returns {{ gids: number[], source: string, complete: boolean } | null} 好友 RPC 解析结果，非好友消息返回 null
   */
  function handleMessage(buffer) {
    if (!buffer || buffer.length === 0) return null;
    let message;
    try {
      message = GateMessage.decode(buffer);
    } catch {
      return null;
    }
    const meta = message && message.meta;
    if (!meta) return null;

    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    if (serviceName !== FRIEND_SERVICE) return null;
    if (!COMPLETE_METHODS.has(methodName) && !PARTIAL_METHODS.has(methodName)) return null;

    const body = message.body;
    if (!body || body.length === 0) return null;

    const replyType = replyTypes[methodName];
    let gids = [];
    if (replyType) {
      try {
        const reply = replyType.decode(body);
        const friends = Array.isArray(reply && reply.game_friends) ? reply.game_friends : [];
        gids = friends
          .map(friend => Number(friend && friend.gid))
          .filter(gid => Number.isSafeInteger(gid) && gid > 0);
      } catch {
        gids = [];
      }
    }

    return {
      gids,
      source: `${serviceName}.${methodName}`,
      complete: COMPLETE_METHODS.has(methodName),
    };
  }

  return { handleMessage };
}

module.exports = {
  COMPLETE_METHODS,
  FRIEND_SERVICE,
  PARTIAL_METHODS,
  REPLY_TYPE_MAP,
  createFriendExtractor,
  getProtoPaths,
};
