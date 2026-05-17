// server/scripts/patch-langchain-openai.js
// Purpose: DeepSeek thinking 模式会返回 reasoning_content，并要求下一轮请求携带。
// @langchain/openai 目前不会把该字段从响应写入 message，也不会在下一次请求时带回。
// 这里在 postinstall 阶段对 node_modules 进行最小补丁（幂等）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8')
}

function patchOnce({ filePath, patches }) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[postinstall] skip: not found ${filePath}`)
    return { filePath, changed: false, skipped: true }
  }

  const original = readText(filePath)
  let updated = original
  let changed = false

  for (const { id, apply } of patches) {
    const next = apply(updated)
    if (next !== updated) {
      updated = next
      changed = true
      console.log(`[postinstall] patched ${id}: ${path.relative(PROJECT_ROOT, filePath)}`)
    }
  }

  if (changed) {
    writeText(filePath, updated)
  }

  return { filePath, changed, skipped: false }
}

function insertBeforeOnce(text, marker, insertText) {
  const idx = text.indexOf(marker)
  if (idx === -1) return text
  // already inserted?
  if (text.includes(insertText.trim())) return text
  return text.slice(0, idx) + insertText + text.slice(idx)
}

function insertAfterRegexOnce(text, regex, insertText) {
  if (text.includes(insertText.trim())) return text
  const match = text.match(regex)
  if (!match) return text
  return text.replace(regex, (m) => m + insertText)
}

const targetFiles = [
  path.join(PROJECT_ROOT, 'node_modules', '@langchain', 'openai', 'dist', 'chat_models.js'),
  path.join(PROJECT_ROOT, 'node_modules', '@langchain', 'openai', 'dist', 'chat_models.cjs'),
]

const reasoningFromResponsePatch = {
  id: 'capture reasoning_content from response',
  apply: (text) => {
    // After: const additional_kwargs = { function_call: ..., tool_calls: ... };
    const regex = /const additional_kwargs = \{\n\s*function_call: message\.function_call,\n\s*tool_calls: rawToolCalls,\n\s*\};/m
    const insert = "\n            if (message.reasoning_content != null) {\n                additional_kwargs.reasoning_content = message.reasoning_content;\n            }"
    return insertAfterRegexOnce(text, regex, insert)
  },
}

const reasoningFromDeltaPatch = {
  id: 'capture reasoning_content from streaming delta',
  apply: (text) => {
    const marker = "    if (includeRawResponse) {\n        additional_kwargs.__raw_response = rawResponse;\n    }"
    const insert = "    if (delta.reasoning_content != null) {\n        additional_kwargs.reasoning_content = delta.reasoning_content;\n    }\n"
    return insertBeforeOnce(text, marker, insert)
  },
}

const reasoningToRequestPatch = {
  id: 'send reasoning_content back in messages',
  apply: (text) => {
    const marker = "        if (message.additional_kwargs.audio &&"
    const insert = "        if (role === \"assistant\" && message.additional_kwargs.reasoning_content != null) {\n            completionParam.reasoning_content = message.additional_kwargs.reasoning_content;\n        }\n"
    return insertBeforeOnce(text, marker, insert)
  },
}

let anyChanged = false
for (const filePath of targetFiles) {
  const result = patchOnce({
    filePath,
    patches: [reasoningFromResponsePatch, reasoningFromDeltaPatch, reasoningToRequestPatch],
  })
  anyChanged = anyChanged || result.changed
}

if (!anyChanged) {
  console.log('[postinstall] @langchain/openai already patched (or no changes needed)')
}
