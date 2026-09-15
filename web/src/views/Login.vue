<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useUserStore } from '@/stores/user'

declare const __APP_VERSION__: string

type Mode = 'login' | 'register' | 'renew' | 'reset'

const userStore = useUserStore()
const appVersion = __APP_VERSION__
const gameVersion = ref('')
const mode = ref<Mode>('login')

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const cardCode = ref('')
const qq = ref('')
const error = ref('')
const success = ref('')
const loading = ref(false)
const lockoutRemaining = ref(0)
const rateLimitRemaining = ref(0)

const loginConfig = ref({
  logoUrl: '',
  loginSubtitle: '欢迎回来，请登录你的账号',
  registerSubtitle: '注册新账号，开启自动化农场之旅',
  purchaseUrl: '',
  qqGroupUrl: '',
})

const titleMap: Record<Mode, string> = {
  login: '账号登录',
  register: '注册新账号',
  renew: '卡密续费',
  reset: '找回密码',
}

const usernameValid = computed(() => {
  const name = username.value
  if (!name)
    return { valid: false, message: '' }
  if (name.length < 3)
    return { valid: false, message: '用户名至少3位' }
  if (name.length > 32)
    return { valid: false, message: '用户名最多32位' }
  if (!/^\w+$/.test(name))
    return { valid: false, message: '只能包含字母、数字、下划线' }
  return { valid: true, message: '' }
})

const qqValid = computed(() => {
  if (!qq.value)
    return true
  return /^\d{5,12}$/.test(qq.value)
})

function switchMode(next: Mode) {
  mode.value = next
  error.value = ''
  success.value = ''
  password.value = ''
  confirmPassword.value = ''
  cardCode.value = ''
}

function validateForm(): boolean {
  if (!username.value) {
    error.value = '请输入用户名'
    return false
  }
  if (mode.value === 'register' && !usernameValid.value.valid) {
    error.value = usernameValid.value.message
    return false
  }
  if (mode.value === 'register' && !qqValid.value) {
    error.value = '绑定QQ格式不正确（需为5-12位数字）'
    return false
  }
  if (mode.value !== 'renew' && !password.value) {
    error.value = '请输入密码'
    return false
  }
  if ((mode.value === 'register' || mode.value === 'reset') && password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return false
  }
  if ((mode.value === 'register' || mode.value === 'renew' || mode.value === 'reset') && !cardCode.value) {
    error.value = '请输入卡密'
    return false
  }
  return true
}

function applyResultError(data: any, fallback: string) {
  if (data?.errorType === 'rate_limit') {
    error.value = getApiErrorMessage(data, '请求过于频繁')
    if (data.remainingMs)
      rateLimitRemaining.value = Math.ceil(data.remainingMs / 1000)
  }
  else if (data?.errorType === 'locked') {
    error.value = getApiErrorMessage(data, '账户已被锁定')
    if (data.remainingMs)
      lockoutRemaining.value = Math.ceil(data.remainingMs / 1000 / 60)
  }
  else {
    error.value = getApiErrorMessage(data, fallback)
  }
}

async function handleLogin() {
  try {
    const result = await userStore.login(username.value, password.value)
    if (result.ok) {
      success.value = result.data?.mustChangePassword ? '登录成功，请修改默认密码' : '登录成功'
      setTimeout(() => {
        window.location.href = '/'
      }, 500)
    }
    else {
      applyResultError(result, '登录失败')
    }
  }
  catch (e: any) {
    applyResultError(e.response?.data || e, '操作异常')
  }
}

async function handleRegister() {
  try {
    const res = await userStore.register({
      username: username.value,
      password: password.value,
      cardCode: cardCode.value,
      qq: qq.value,
    })
    if (res.ok) {
      success.value = '注册成功，请使用新账号登录'
      setTimeout(() => switchMode('login'), 800)
    }
    else {
      error.value = res.error || '注册失败'
    }
  }
  catch (e: any) {
    applyResultError(e.response?.data || e, '注册失败')
  }
}

async function handleRenew() {
  try {
    const res = await userStore.publicRenew(username.value, cardCode.value)
    if (res.ok)
      success.value = '续费成功，请重新登录'
    else
      error.value = res.error || '续费失败'
  }
  catch (e: any) {
    applyResultError(e.response?.data || e, '续费失败')
  }
}

async function handleReset() {
  try {
    const res = await userStore.resetPassword(username.value, cardCode.value, password.value)
    if (res.ok) {
      success.value = '密码重置成功，请使用新密码登录'
      setTimeout(() => switchMode('login'), 800)
    }
    else {
      error.value = res.error || '密码重置失败'
    }
  }
  catch (e: any) {
    applyResultError(e.response?.data || e, '密码重置失败')
  }
}

async function handleSubmit() {
  if (!validateForm())
    return
  loading.value = true
  error.value = ''
  success.value = ''
  try {
    if (mode.value === 'login')
      await handleLogin()
    else if (mode.value === 'register')
      await handleRegister()
    else if (mode.value === 'renew')
      await handleRenew()
    else
      await handleReset()
  }
  finally {
    loading.value = false
  }
}

async function fetchGameVersion() {
  try {
    const res = await api.get('/api/game-version')
    if (res.data.ok)
      gameVersion.value = res.data.clientVersion
  }
  catch (e) {
    console.error('获取游戏版本失败:', e)
  }
}

async function fetchLoginConfig() {
  try {
    const res = await api.get('/api/public/login-config', { skipErrorToast: true } as any)
    if (res.data.ok && res.data.data)
      loginConfig.value = { ...loginConfig.value, ...res.data.data }
  }
  catch (e) {
    console.error('获取登录配置失败:', e)
  }
}

onMounted(() => {
  fetchGameVersion()
  fetchLoginConfig()
})
</script>

<template>
  <main class="login-container">
    <section class="login-card">
      <header class="logo-area">
        <div class="logo-icon">
          <img :src="loginConfig.logoUrl || '/icon.png'" alt="">
        </div>
        <div>
          <span class="logo-kicker">QQ FARM</span>
          <h1 class="logo-title">
            QQ农场智能助手
          </h1>
          <p class="logo-subtitle">
            {{ mode === 'register' ? loginConfig.registerSubtitle : loginConfig.loginSubtitle }}
          </p>
        </div>
      </header>

      <nav class="mode-tabs">
        <button
          v-for="item in ([['login', '登录'], ['register', '注册'], ['renew', '续费'], ['reset', '找回密码']] as const)"
          :key="item[0]"
          type="button"
          class="mode-tab"
          :class="{ active: mode === item[0] }"
          @click="switchMode(item[0])"
        >
          {{ item[1] }}
        </button>
      </nav>

      <form class="form-area" @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label" for="username">
            <span class="i-carbon-user" />
            用户名
          </label>
          <BaseInput
            id="username"
            v-model="username"
            type="text"
            placeholder="请输入用户名"
            autocomplete="username"
            required
          />
          <p v-if="mode === 'register' && username && !usernameValid.valid" class="form-hint error">
            {{ usernameValid.message }}
          </p>
        </div>

        <div v-if="mode === 'register'" class="form-group">
          <label class="form-label" for="qq">
            <span class="i-carbon-logo-qq" />
            绑定QQ
          </label>
          <BaseInput
            id="qq"
            v-model="qq"
            type="text"
            placeholder="请输入要绑定的QQ号"
            autocomplete="off"
          />
          <p v-if="qq && !qqValid" class="form-hint error">
            绑定QQ格式不正确（需为5-12位数字）
          </p>
        </div>

        <div v-if="mode !== 'renew'" class="form-group">
          <label class="form-label" for="password">
            <span class="i-carbon-locked" />
            {{ mode === 'reset' ? '新密码' : '密码' }}
          </label>
          <BaseInput
            id="password"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            required
          />
        </div>

        <div v-if="mode === 'register' || mode === 'reset'" class="form-group">
          <label class="form-label" for="confirmPassword">
            <span class="i-carbon-locked" />
            确认密码
          </label>
          <BaseInput
            id="confirmPassword"
            v-model="confirmPassword"
            type="password"
            placeholder="请再次输入密码"
            autocomplete="new-password"
            required
          />
        </div>

        <div v-if="mode !== 'login'" class="form-group">
          <label class="form-label" for="cardCode">
            <span class="i-carbon-ticket" />
            卡密
          </label>
          <BaseInput
            id="cardCode"
            v-model="cardCode"
            type="text"
            placeholder="请输入卡密"
            autocomplete="off"
            required
          />
        </div>

        <div v-if="error" class="message error-message" role="alert">
          <span class="i-carbon-warning-alt" />
          <div>
            {{ error }}
            <span v-if="lockoutRemaining > 0">（{{ lockoutRemaining }} 分钟后解锁）</span>
            <span v-if="rateLimitRemaining > 0">（{{ rateLimitRemaining }} 秒后可重试）</span>
          </div>
        </div>
        <div v-if="success" class="message success-message" role="status">
          <span class="i-carbon-checkmark-filled" />
          {{ success }}
        </div>

        <BaseButton type="submit" variant="primary" block :loading="loading" class="submit-btn">
          <span v-if="!loading" class="inline-flex items-center gap-2">
            <span class="i-carbon-login" />
            {{ titleMap[mode] }}
          </span>
        </BaseButton>
      </form>

      <footer class="card-footer">
        <div class="footer-info">
          <span>Web v{{ appVersion }}</span>
          <span v-if="gameVersion">Game {{ gameVersion }}</span>
        </div>
        <div class="footer-actions">
          <a
            v-if="loginConfig.qqGroupUrl"
            :href="loginConfig.qqGroupUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="footer-link"
            title="加入QQ群"
            aria-label="加入QQ群"
          >
            <span class="i-carbon-group" />
            <span class="footer-link__text">加入QQ群</span>
          </a>
          <a
            v-if="loginConfig.purchaseUrl"
            :href="loginConfig.purchaseUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="footer-link"
            title="购买卡密"
            aria-label="购买卡密"
          >
            <span class="i-carbon-shopping-cart" />
            <span class="footer-link__text">购买卡密</span>
          </a>
          <a href="https://github.com/liyangpengs/qq-farm-bot" target="_blank" rel="noopener noreferrer" class="footer-link" aria-label="GitHub">
            <span class="i-carbon-logo-github" />
          </a>
        </div>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.login-container {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: 28px 18px;
  color: var(--ui-ink);
  background-color: #edf2ea;
  background-image:
    linear-gradient(rgba(67, 141, 99, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(67, 141, 99, 0.045) 1px, transparent 1px);
  background-size: 42px 42px;
}

.login-container::before {
  position: absolute;
  inset: 8% 7%;
  border: 1px solid rgba(67, 141, 99, 0.08);
  border-radius: 36px;
  background: rgba(255, 255, 255, 0.22);
  content: '';
}

.login-card {
  position: relative;
  z-index: 1;
  width: min(430px, 100%);
  padding: 30px;
  border: 1px solid rgba(58, 86, 68, 0.14);
  border-radius: 18px;
  background: rgba(250, 251, 247, 0.82);
  box-shadow:
    0 28px 76px rgba(55, 75, 61, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.94);
  -webkit-backdrop-filter: blur(24px) saturate(135%);
  backdrop-filter: blur(24px) saturate(135%);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--ui-border);
}

.logo-icon {
  display: grid;
  width: 58px;
  height: 58px;
  flex: none;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(67, 141, 99, 0.16);
  border-radius: 16px;
  background: var(--ui-primary-soft);
}

.logo-icon img {
  width: 42px;
  height: 42px;
  object-fit: contain;
}

.logo-kicker {
  color: var(--ui-primary);
  font-size: 10px;
  font-weight: 700;
}

.logo-title {
  margin: 2px 0 0;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: 0;
}

.logo-subtitle {
  margin: 5px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
}

.mode-tabs {
  display: flex;
  gap: 6px;
  padding: 14px 0 4px;
}

.mode-tab {
  flex: 1;
  padding: 7px 0;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--ui-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.16s ease;
}

.mode-tab.active {
  border-color: rgba(67, 141, 99, 0.24);
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

.form-area {
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding-top: 16px;
}

.form-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}

.form-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-ink);
  font-size: 13px;
  font-weight: 600;
}

.form-label > span {
  color: var(--ui-primary);
}

.form-hint {
  margin: 0;
  color: var(--ui-danger);
  font-size: 11px;
}

.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}

.error-message {
  border-color: rgba(201, 95, 102, 0.18);
  color: #984049;
  background: var(--ui-danger-soft);
}

.success-message {
  border-color: rgba(67, 141, 99, 0.18);
  color: #2e714b;
  background: var(--ui-primary-soft);
}

.submit-btn {
  margin-top: 2px;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 22px;
  padding-top: 17px;
  border-top: 1px solid var(--ui-border);
  color: var(--ui-subtle);
  font-size: 10px;
}

.footer-info {
  display: flex;
  gap: 12px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.footer-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  color: var(--ui-muted);
  font-size: 11px;
  text-decoration: none;
}

.footer-link:hover {
  color: var(--ui-primary);
  background: var(--ui-primary-soft);
}

@media (max-width: 480px) {
  .login-container {
    align-items: center;
    padding: 16px 12px;
  }

  .login-container::before {
    inset: 4%;
    border-radius: 24px;
  }

  .login-card {
    padding: 24px 20px;
    border-radius: 16px;
  }

  .logo-icon {
    width: 52px;
    height: 52px;
  }

  .logo-title {
    font-size: 19px;
  }

  .footer-link__text {
    display: none;
  }
}
</style>
