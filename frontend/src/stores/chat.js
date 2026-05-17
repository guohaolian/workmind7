// frontend/src/stores/chat.js
// 对话模块全局状态：会话列表、当前会话消息、角色、用户画像
import { defineStore } from 'pinia'
import { ref, computed, reactive, watch } from 'vue'
import { fetchStream } from '@/utils/http.js'
import http from '@/utils/http.js'
import { useAppStore } from './app.js'
import { useMonitorStore } from './monitor.js'

const CHAT_STORAGE_KEY = 'workmind.chat.state.v1'

function hasStorage() {
  return typeof window !== 'undefined' && !!window.localStorage
}

function normalizeMessage(raw = {}) {
  return {
    id: typeof raw.id === 'string' ? raw.id : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: typeof raw.content === 'string' ? raw.content : String(raw.content || ''),
    fromCache: !!raw.fromCache,
    // 刷新后无法继续旧连接的流式状态，统一改为 false
    streaming: false,
    time: typeof raw.time === 'string' ? raw.time : new Date().toISOString(),
  }
}

function normalizeSession(raw = {}) {
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage) : []
  const fallbackTitle = messages[0]?.content ? messages[0].content.slice(0, 20) : '新对话'

  return {
    id: typeof raw.id === 'string' ? raw.id : `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : fallbackTitle,
    messages,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  }
}

export const useChatStore = defineStore('chat', () => {
  const appStore     = useAppStore()
  const monitorStore = useMonitorStore()
  let storageReady = false

  // 当前流式请求的取消句柄（用于“停止生成”）
  let activeStreamController = null
  let activeStreamRequestId = 0

  // ── 会话列表 ──────────────────────────────────────────────────
  // 每个会话：{ id, title, messages: [], createdAt }
  const sessions    = ref([])
  const currentId   = ref(null)

  const currentSession = computed(() =>
    sessions.value.find(s => s.id === currentId.value) || null
  )

  const messages = computed(() =>
    currentSession.value?.messages || []
  )

  function restoreState() {
    if (!hasStorage()) return

    try {
      const raw = window.localStorage.getItem(CHAT_STORAGE_KEY)
      if (!raw) return

      const parsed = JSON.parse(raw)
      const restoredSessions = Array.isArray(parsed?.sessions)
        ? parsed.sessions.map(normalizeSession)
        : []

      sessions.value = restoredSessions
      currentId.value = typeof parsed?.currentId === 'string' ? parsed.currentId : null
      if (typeof parsed?.selectedRole === 'string' && parsed.selectedRole) {
        selectedRole.value = parsed.selectedRole
      }
      if (typeof parsed?.userId === 'string' && parsed.userId) {
        userId.value = parsed.userId
      }
    } catch {
      // 存储损坏时忽略，走默认初始化
    }
  }

  function persistState() {
    if (!hasStorage()) return

    const payload = {
      sessions: sessions.value.map(s => ({
        id: s.id,
        title: s.title,
        messages: (s.messages || []).map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          fromCache: !!m.fromCache,
          streaming: false,
          time: m.time,
        })),
        createdAt: s.createdAt,
      })),
      currentId: currentId.value,
      selectedRole: selectedRole.value,
      userId: userId.value,
    }

    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // 存储空间不足时静默失败，不影响主流程
    }
  }

  // ── 初始化：创建第一个会话 ────────────────────────────────────
  function init() {
    if (!storageReady) {
      restoreState()
      storageReady = true
    }

    // 恢复后若 currentId 无效，自动回退到第一个会话
    if (currentId.value && !sessions.value.some(s => s.id === currentId.value)) {
      currentId.value = sessions.value[0]?.id || null
    }

    if (sessions.value.length === 0) {
      newSession()
    } else if (!currentId.value) {
      currentId.value = sessions.value[0].id
    }

    persistState()
  }

  function newSession() {
    const id = `session_${Date.now()}`
    sessions.value.unshift({
      id,
      title: '新对话',
      messages: [],
      createdAt: new Date().toISOString(),
    })
    currentId.value = id
    return id
  }

  function switchSession(id) {
    currentId.value = id
  }

  function deleteSession(id) {
    const idx = sessions.value.findIndex(s => s.id === id)
    if (idx === -1) return
    sessions.value.splice(idx, 1)

    // 如果删的是当前会话，切到第一个
    if (currentId.value === id) {
      currentId.value = sessions.value[0]?.id || null
      if (!currentId.value) newSession()
    }

    // 同步删除服务端会话历史
    http.delete(`/chat/sessions/${id}`).catch(() => {})
  }

  // 根据第一条消息自动生成会话标题
  function updateTitle(sessionId, firstMessage) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s && s.title === '新对话') {
      s.title = firstMessage.slice(0, 20) + (firstMessage.length > 20 ? '...' : '')
    }
  }

  // ── 角色 ──────────────────────────────────────────────────────
  const selectedRole = ref('default')
  const roles = ref([])

  async function loadRoles() {
    try {
      const data = await http.get('/chat/roles')
      roles.value = data.roles
    } catch {}
  }

  // ── 用户画像 ──────────────────────────────────────────────────
  const profile = ref({})
  const userId  = ref('user-demo')

  async function loadProfile() {
    try {
      const data = await http.get(`/chat/profile/${userId.value}`)
      profile.value = data
    } catch {}
  }

  // ── 发送消息（核心）──────────────────────────────────────────
  const loading = ref(false)

  function stopGenerate() {
    if (!loading.value) return

    // 立即让 UI 退出 loading，避免按钮“没反应”的感觉
    loading.value = false

    try {
      activeStreamController?.abort()
    } catch {}
    activeStreamController = null

    // 关闭最后一条 AI 消息的 streaming 光标
    const session = currentSession.value
    const lastMsg = session?.messages?.[session.messages.length - 1]
    if (lastMsg?.role === 'assistant') {
      lastMsg.streaming = false
    }
  }

  async function sendMessage(text) {
    if (!text.trim() || loading.value) return
    if (!currentId.value) newSession()

    const session = currentSession.value
    if (!session) return
    loading.value = true

    // 生成新的请求上下文（支持取消）
    activeStreamRequestId += 1
    const requestId = activeStreamRequestId
    try {
      activeStreamController?.abort()
    } catch {}
    const controller = new AbortController()
    activeStreamController = controller

    // 添加用户消息
    const userMsg = {
      id:      `msg_${Date.now()}`,
      role:    'user',
      content: text,
      time:    new Date().toISOString(),
    }
    session.messages.push(userMsg)
    updateTitle(currentId.value, text)

    // 添加 AI 消息占位（流式填充）
    const aiMsgSeed = {
      id:         `msg_${Date.now() + 1}`,
      role:       'assistant',
      content:    '',
      fromCache:  false,
      streaming:  true,
      time:       new Date().toISOString(),
    }
    session.messages.push(reactive(aiMsgSeed))
    // 必须拿到数组内的响应式对象再更新，避免流式 token 更新不触发视图刷新
    const aiMsg = session.messages[session.messages.length - 1]

    let hasTerminalEvent = false
    let receivedToken = false

    try {
      await fetchStream(
        '/api/chat/stream',
        {
          message:   text,
          sessionId: currentId.value,
          role:      selectedRole.value,
          userId:    userId.value,
        },
        {
          signal: controller.signal,
          onToken: (token) => {
            if (requestId !== activeStreamRequestId || controller.signal.aborted) return
            receivedToken = true
            aiMsg.content += token
          },
          onEvent: (event, data) => {
            if (requestId !== activeStreamRequestId) return
            if (event === 'cache_hit') aiMsg.fromCache = true
            if (event === 'start')     aiMsg.streaming = true
          },
          onDone: (data) => {
            if (requestId !== activeStreamRequestId) return
            hasTerminalEvent = true
            aiMsg.streaming = false
            // 记录用量
            if (!data.fromCache) {
              monitorStore.recordCall({
                inputTokens:  data.inputTokens || 0,
                outputTokens: data.outputTokens || 0,
                fromCache:    false,
                feature:      'chat',
              })
            } else {
              monitorStore.recordCall({ fromCache: true, feature: 'chat' })
            }
            // 刷新画像（后台可能更新了）
            loadProfile()
          },
          onAbort: () => {
            hasTerminalEvent = true
            aiMsg.streaming = false
          },
          onError: (err) => {
            if (requestId !== activeStreamRequestId) return
            hasTerminalEvent = true
            aiMsg.streaming = false
            aiMsg.content   = aiMsg.content || '抱歉，出现了一些问题，请重试。'
            appStore.toast.error(err.message || '发送失败')
          },
        }
      )
    } finally {
      if (activeStreamController === controller) {
        activeStreamController = null
      }
      if (!hasTerminalEvent) {
        aiMsg.streaming = false
        if (!receivedToken) {
          aiMsg.content = '未收到模型响应，请检查后端服务或前端 API 地址配置。'
        }
      }
      if (requestId === activeStreamRequestId) {
        loading.value = false
      }
    }
  }

  // 重新生成某一条 AI 回复（默认：最后一条 assistant）
  // 说明：为了保持对话一致性，会从该回复对应的上一条 user 消息开始裁剪后续消息，再重新发送该 user 内容。
  async function regenerate(targetAssistantMessageId) {
    const session = currentSession.value
    const msgs = session?.messages || []
    if (!msgs.length) return

    // 如果当前还在生成，先中止，避免并发写入 messages
    if (loading.value) stopGenerate()

    let targetIdx = -1
    if (typeof targetAssistantMessageId === 'string' && targetAssistantMessageId) {
      targetIdx = msgs.findIndex(m => m.id === targetAssistantMessageId)
    } else {
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'assistant') {
          targetIdx = i
          break
        }
      }
    }

    if (targetIdx === -1 || msgs[targetIdx]?.role !== 'assistant') return

    // 寻找该 assistant 回复对应的上一条 user 消息
    let userIdx = -1
    for (let i = targetIdx - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx === -1) return

    const userContent = msgs[userIdx]?.content || ''
    if (!userContent.trim()) return

    // 裁剪从该 user 消息开始的所有后续（包含该 user 与该 assistant 以及之后的上下文）
    msgs.splice(userIdx)

    await sendMessage(userContent)
  }

  // 复制消息内容
  async function copyMessage(content) {
    await navigator.clipboard.writeText(content)
    appStore.toast.success('已复制到剪贴板')
  }

  watch(
    [sessions, currentId, selectedRole, userId],
    () => {
      if (!storageReady) return
      persistState()
    },
    { deep: true }
  )

  return {
    sessions, currentId, currentSession, messages,
    selectedRole, roles,
    profile, userId,
    loading,
    init, newSession, switchSession, deleteSession,
    loadRoles, loadProfile,
    sendMessage, stopGenerate, regenerate, copyMessage,
  }
})
