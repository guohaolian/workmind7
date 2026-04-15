// frontend/src/utils/http.js
// 统一封装 axios：请求拦截、响应拦截、错误处理
import axios from 'axios'
import { useAppStore } from '@/stores/app.js'

// 创建 axios 实例
const http = axios.create({
  baseURL: '/api',           // 配合 vite proxy，开发时自动转发到 :3000
  timeout: 30000,            // 普通请求 30s 超时
})

// ── 请求拦截器 ─────────────────────────────────────────────────
http.interceptors.request.use(
  (config) => {
    // 可以在这里加 token：config.headers.Authorization = `Bearer ${token}`
    return config
  },
  (error) => Promise.reject(error)
)

// ── 响应拦截器 ─────────────────────────────────────────────────
http.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const appStore = useAppStore()

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      appStore.toast.error('请求超时，请稍后重试')
    } else if (error.response) {
      const status = error.response.status
      const msg = error.response.data?.error || '请求失败'

      if (status === 429) {
        appStore.toast.warning('请求太频繁，请稍后再试')
      } else if (status >= 500) {
        appStore.toast.error('服务器异常，请稍后重试')
      } else {
        appStore.toast.error(msg)
      }
    } else {
      appStore.toast.error('网络异常，请检查连接')
    }

    return Promise.reject(error)
  }
)

// ── SSE 流式请求工具 ───────────────────────────────────────────
// 浏览器原生 fetch + ReadableStream，不走 axios
// onToken：每收到一个 token 的回调
// onEvent：收到特定事件（sources、tool_start 等）的回调
// onDone：流结束时的回调
// onError：出错时的回调
export async function fetchStream(url, body, { onToken, onEvent, onDone, onError } = {}) {
  try {
    const buildCandidates = (path) => {
      if (/^https?:\/\//i.test(path)) return [path]
      const candidates = [path]
      if (path.startsWith('/api/')) {
        candidates.push(`http://localhost:3000${path}`)
      }
      return [...new Set(candidates)]
    }

    const candidates = buildCandidates(url)
    let lastError = new Error('流式请求失败')

    for (const requestUrl of candidates) {
      let response
      try {
        response = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (err) {
        const message = err?.message || '网络连接失败'
        lastError = new Error(`请求 ${requestUrl} 失败：${message}`)
        continue
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        lastError = new Error(data.error || `HTTP ${response.status}`)
        continue
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      if (!contentType.includes('text/event-stream')) {
        const raw = await response.text().catch(() => '')
        const isHtml = raw.includes('<!doctype html') || raw.includes('<html')
        lastError = new Error(
          isHtml
            ? '未连接到对话后端，请检查前端代理或 VITE_API_BASE_URL 配置'
            : `流式接口返回格式错误: ${contentType || 'unknown'}`
        )
        continue
      }

      if (!response.body) {
        lastError = new Error('浏览器不支持流式响应')
        continue
      }

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let hasTerminalEvent = false

      const dispatchPart = (rawPart) => {
        const part = rawPart.trim()
        if (!part) return

        const lines = part.split('\n')
        let event = 'message'
        const dataLines = []

        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }

        if (dataLines.length === 0) return

        const dataStr = dataLines.join('\n')
        let data
        try {
          data = JSON.parse(dataStr)
        } catch {
          return
        }

        if (event === 'token' && onToken) {
          onToken(data.token || '')
        } else if (event === 'done') {
          hasTerminalEvent = true
          onDone?.(data)
        } else if (event === 'error') {
          hasTerminalEvent = true
          onError?.(new Error(data.message || '流式请求出错'))
        } else if (onEvent) {
          onEvent(event, data)
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n')

        // SSE 格式：event 和 data 之间用 \n\n 分隔
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          dispatchPart(part)
        }
      }

      // 处理最后残留的未分隔片段
      const tail = buffer + decoder.decode()
      if (tail.trim()) dispatchPart(tail)

      if (!hasTerminalEvent) {
        lastError = new Error('连接已结束，但未收到模型完成事件')
        continue
      }

      return
    }

    throw lastError
  } catch (err) {
    onError?.(err)
  }
}

export default http
