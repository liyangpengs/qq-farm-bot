/**
 * 添加管理员账户
 * 用法: node add-admin.js <用户名> <密码>
 *
 * 示例: node add-admin.js user2 mypassword123
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ADMIN_FILE = path.join(__dirname, 'core', 'data', 'admin.json');

const [,, username, password] = process.argv;

if (!username || !password) {
    console.error('用法: node add-admin.js <用户名> <密码>');
    console.error('示例: node add-admin.js user2 mypassword123');
    process.exit(1);
}

// 密码强度校验
if (password.length < 6) {
    console.error('错误: 密码长度至少6位');
    process.exit(1);
}
if (password.length > 128) {
    console.error('错误: 密码长度不能超过128位');
    process.exit(1);
}

// bcrypt hash
const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';
const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
const hashedPassword = `${salt}:${hash}`;

// 确保目录存在
const dataDir = path.dirname(ADMIN_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// 读取现有数据
let admins = [];
if (fs.existsSync(ADMIN_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        // 新格式: { admins: [...] }
        if (Array.isArray(data?.admins)) {
            admins = data.admins;
        }
        // 兼容旧格式: { admin: {...} }
        if (admins.length === 0 && data?.admin) {
            admins = [data.admin];
        }
    } catch (e) {
        console.error('错误: 无法解析 admin.json，文件可能已损坏');
        process.exit(1);
    }
}

// 检查是否已存在
const existing = admins.find(a => a.username === username);
if (existing) {
    console.error(`错误: 管理员 "${username}" 已存在`);
    process.exit(1);
}

// 添加新管理员
admins.push({
    username,
    password: hashedPassword,
    createdAt: Date.now(),
});

// 写入
fs.writeFileSync(ADMIN_FILE, JSON.stringify({ admins }, null, 2), 'utf8');
console.log(`管理员 "${username}" 已添加成功`);