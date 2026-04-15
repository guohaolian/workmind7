// server/src/config/index.js
// 统一配置入口：所有环境变量从这里读取，业务代码不直接用 process.env
import 'dotenv/config'

function normalizeEmbedBaseURL(url) {
  const raw = (url || '').trim()
  if (!raw) return 'https://api.siliconflow.cn/v1'

  const cleaned = raw.replace(/\/+$/, '')
  // OpenAI SDK 会自动拼接 /embeddings，这里只保留到 /v1
  if (cleaned.endsWith('/embeddings')) {
    return cleaned.slice(0, -'/embeddings'.length)
  }
  return cleaned
}

export const config = {
  app: {
    port: Number(process.env.PORT) || 3000,
    env:  process.env.NODE_ENV || 'development',
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
  },
  ai: {
    deepseekKey:   process.env.DEEPSEEK_API_KEY,
    openaiKey:     process.env.OPENAI_API_KEY,
    primaryModel:  process.env.PRIMARY_MODEL  || 'deepseek-chat',
    embedModel:    process.env.EMBED_MODEL    || 'BAAI/bge-large-zh-v1.5',
    baseURL:       'https://api.deepseek.com/v1',
    embedBaseURL:  normalizeEmbedBaseURL(process.env.EMBED_BASE_URL),
  },
  chroma: {
    url: process.env.CHROMA_URL || 'http://localhost:8006',
  },
  cache: {
    ttl: Number(process.env.CACHE_TTL) || 1800000,  // 30 分钟
  },
}

export function validateConfig() {
  if (!config.ai.deepseekKey) {
    console.error('❌ 缺少 DEEPSEEK_API_KEY，请在 .env 文件中配置')
    process.exit(1)
  }
  console.log('✓ 配置校验通过')
}
