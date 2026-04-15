// server/src/services/model.js
// 模型工厂：统一创建模型实例，业务代码不直接 new ChatOpenAI
import { ChatOpenAI } from '@langchain/openai'
import { OpenAIEmbeddings } from '@langchain/openai'
import { config } from '../config/index.js'

/**
 * 创建对话模型
 * @param {object} options
 * @param {number}  options.temperature  - 随机性，0=确定，1=创意
 * @param {boolean} options.streaming    - 是否流式输出
 * @param {array}   options.callbacks    - LangChain 回调（如成本追踪）
 */
export function createChatModel({ temperature = 0.7, streaming = false, callbacks = [] } = {}) {
  return new ChatOpenAI({
    model:         config.ai.primaryModel,
    apiKey:        config.ai.deepseekKey,
    configuration: { baseURL: config.ai.baseURL },
    temperature,
    streaming,
    callbacks,
    // 超时 30s（流式可能需要更长，在路由层单独控制）
    timeout: 30000,
  })
}

/**
 * 创建 Embedding 模型（向量化文本，RAG 必用）
 * 注意：DeepSeek 暂无 embedding 模型，这里用 OpenAI 的
 * 如果没有 OpenAI Key，可以换成本地 Ollama 的 embedding 模型
 */
export function createEmbeddings() {
  if (!config.ai.openaiKey) {
    console.warn('⚠️  未配置 OPENAI_API_KEY，RAG 功能将不可用')
    return null
  }
  return new OpenAIEmbeddings({
    model:         config.ai.embedModel,
    apiKey:        config.ai.openaiKey,
    configuration: { baseURL: config.ai.embedBaseURL },
  })
}

// 单例：应用启动时创建一次，全局复用
// 不每次请求都 new，节省内存
export const chatModel = createChatModel({ temperature: 0.7, streaming: true })
export const embeddings = createEmbeddings()
