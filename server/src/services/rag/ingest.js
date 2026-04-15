// server/src/services/rag/ingest.js
// 文档入库：上传 → 读取文本 → 分片 → 向量化 → 存入 Chroma
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { Chroma } from '@langchain/community/vectorstores/chroma'
import { Document } from '@langchain/core/documents'
import { embeddings } from '../model.js'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

const COLLECTION = 'workmind-knowledge'
const INGEST_TIMEOUT_MS = Number(process.env.RAG_INGEST_TIMEOUT_MS) || 120000
const REGISTRY_FILE = path.resolve(process.cwd(), 'uploads', 'doc-registry.json')

function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), ms)
    }),
  ])
}

// ── 向量库单例 ─────────────────────────────────────────────────
let vectorStore = null

export async function getVectorStore() {
  if (vectorStore) return vectorStore

  if (!embeddings) {
    throw new Error('未配置 OPENAI_API_KEY，无法使用 RAG 功能')
  }

  try {
    // 尝试连接已有的集合
    vectorStore = await withTimeout(Chroma.fromExistingCollection(embeddings, {
      collectionName: COLLECTION,
      url: config.chroma.url,
    }), 20000, '连接向量数据库超时，请检查 CHROMA_URL 与 Chroma 服务状态')
    logger.info('rag: connected to existing collection')
  } catch {
    // 集合不存在时创建新的
    vectorStore = new Chroma(embeddings, {
      collectionName: COLLECTION,
      url: config.chroma.url,
    })
    logger.info('rag: created new collection')
  }

  return vectorStore
}

// ── 文档元数据注册表（生产用数据库，这里用 Map 演示）────────
const docRegistry = new Map()

function hydrateDocRegistry() {
  try {
    if (!fsSync.existsSync(REGISTRY_FILE)) return

    const raw = fsSync.readFileSync(REGISTRY_FILE, 'utf-8')
    const docs = JSON.parse(raw)
    if (!Array.isArray(docs)) return

    for (const doc of docs) {
      if (doc?.id) docRegistry.set(doc.id, doc)
    }

    logger.info('rag: restored document registry', { count: docRegistry.size })
  } catch (err) {
    logger.warn('rag: failed to restore document registry', { error: err.message })
  }
}

async function persistDocRegistry() {
  try {
    await fs.mkdir(path.dirname(REGISTRY_FILE), { recursive: true })
    const docs = [...docRegistry.values()]
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(docs, null, 2), 'utf-8')
  } catch (err) {
    logger.warn('rag: failed to persist document registry', { error: err.message })
  }
}

hydrateDocRegistry()

export function getDocRegistry() {
  return [...docRegistry.values()]
}

export function getDoc(docId) {
  return docRegistry.get(docId) || null
}

// ── 文本提取：根据文件类型读取内容 ───────────────────────────
async function extractText(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase()

  // TXT / Markdown：直接读
  if (ext === '.txt' || ext === '.md') {
    return fs.readFile(filePath, 'utf-8')
  }

  // PDF：用 pdf-parse 提取文字
  // 注意：需要安装 pdf-parse：npm install pdf-parse
  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default
      const buffer = await fs.readFile(filePath)
      const data = await pdfParse(buffer)
      return data.text
    } catch (e) {
      logger.warn('pdf-parse not installed, reading as text', { error: e.message })
      // 降级：当纯文本读
      return fs.readFile(filePath, 'utf-8')
    }
  }

  // 其他格式降级为文本
  return fs.readFile(filePath, 'utf-8')
}

// ── 核心：文档入库 ─────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.filePath   - 上传文件的临时路径
 * @param {string} params.fileName   - 原始文件名
 * @param {string} params.title      - 文档标题（用户填写）
 * @param {string} params.category   - 分类（技术文档 / HR制度 / 产品手册...）
 * @param {string} params.mimeType   - MIME 类型
 */
export async function ingestDocument({ filePath, fileName, title, category = '通用', mimeType }) {
  const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  logger.info('rag: ingesting document', { docId, title, category })

  // 1. 提取文本
  const rawText = await extractText(filePath, mimeType)
  if (!rawText.trim()) {
    throw new Error('文档内容为空，无法处理')
  }

  // 2. 文档分片
  // chunkSize=500：每片约 500 字，保证语义完整
  // chunkOverlap=50：相邻片段重叠 50 字，防止语义在边界断裂
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize:    500,
    chunkOverlap: 50,
    separators: ['\n\n', '\n', '。', '；', '，', ' ', ''],
  })

  const chunks = await splitter.createDocuments(
    [rawText],
    [{
      docId,
      title:      title || fileName,
      category,
      fileName,
      uploadedAt: new Date().toISOString(),
    }]
  )

  logger.info('rag: document split', { docId, chunks: chunks.length })

  // 3. 向量化并存入 Chroma
  const vs = await getVectorStore()
  await withTimeout(
    vs.addDocuments(chunks),
    INGEST_TIMEOUT_MS,
    '向量化处理超时，请检查 EMBED_BASE_URL、EMBED_MODEL 与 OPENAI_API_KEY 配置'
  )

  // 4. 注册文档元数据
  const docMeta = {
    id:         docId,
    title:      title || fileName,
    fileName,
    category,
    chunks:     chunks.length,
    chars:      rawText.length,
    uploadedAt: new Date().toISOString(),
    preview:    rawText.slice(0, 120).replace(/\n/g, ' ') + '...',
  }
  docRegistry.set(docId, docMeta)
  await persistDocRegistry()

  // 5. 清理临时文件
  await fs.unlink(filePath).catch(() => {})

  logger.info('rag: ingest complete', { docId, chunks: chunks.length })
  return docMeta
}

// ── 删除文档 ──────────────────────────────────────────────────
export async function deleteDocument(docId) {
  const doc = docRegistry.get(docId)
  if (!doc) throw new Error('文档不存在')

  const vs = await getVectorStore()

  // Chroma 按 metadata 过滤删除
  await vs.delete({ filter: { docId } })

  docRegistry.delete(docId)
  await persistDocRegistry()
  logger.info('rag: document deleted', { docId })
}
