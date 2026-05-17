// server/src/services/erp/parser.js
// 自然语言 → 结构化表单：用结构化输出解析用户的口语化描述
import { z } from 'zod'
import { createChatModel } from '../model.js'

const model = createChatModel({ temperature: 0 })

function isToolChoiceUnsupportedError(err) {
  const message = (err?.message || '').toLowerCase()
  return (
    message.includes('tool_choice') &&
    (message.includes('does not support') || message.includes('not support') || message.includes('unsupported'))
  )
}

function messageContentToString(content) {
  if (typeof content === 'string') return content
  if (!content) return ''
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return ''
        if (typeof part === 'string') return part
        if (typeof part?.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return String(content)
}

function extractJsonObject(text) {
  const raw = (text || '').trim()
  if (!raw) throw new Error('empty model output')

  try {
    return JSON.parse(raw)
  } catch {
    // 尝试截取首尾大括号之间的内容
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const candidate = raw.slice(start, end + 1)
      return JSON.parse(candidate)
    }
    throw new Error(`failed to parse JSON from model output: ${raw.slice(0, 300)}`)
  }
}

async function invokeStructuredOrJson(schema, messages, { jsonSpecHint } = {}) {
  try {
    const extractModel = model.withStructuredOutput(schema)
    return await extractModel.invoke(messages)
  } catch (err) {
    if (!isToolChoiceUnsupportedError(err)) throw err

    // DeepSeek 的部分模型（如 deepseek-reasoner）不支持 tool_choice。
    // 这里降级为：让模型直接输出 JSON，然后本地用 Zod 校验。
    const jsonOnlySystem = {
      role: 'system',
      content:
        `你必须只输出一个 JSON 对象，禁止输出 Markdown、解释文字或代码块。` +
        `\n- 所有字段必须符合约束；数字必须为 number（不要带单位）。` +
        `\n- 不确定/缺失的信息：尽量给出合理推断；无法推断时在 warnings 里说明，并用空字符串/0/[] 兜底。` +
        (jsonSpecHint ? `\n\nJSON 格式要求：\n${jsonSpecHint}` : ''),
    }

    const response = await model.invoke([jsonOnlySystem, ...messages])
    const content = messageContentToString(response?.content)
    const obj = extractJsonObject(content)
    return schema.parse(obj)
  }
}

// ── 报销申请解析 ──────────────────────────────────────────────
const ExpenseSchema = z.object({
  type: z.enum(['travel', 'meal', 'office', 'training', 'other'])
    .describe('费用类型：travel=差旅, meal=餐饮, office=办公用品, training=培训, other=其他'),
  items: z.array(z.object({
    name:   z.string().describe('费用项目名称，如"高铁票""住宿费"'),
    amount: z.coerce.number().describe('金额，单位：元'),
    date:   z.string().optional().describe('发生日期，格式 YYYY-MM-DD'),
    note:   z.string().optional().describe('备注'),
  })).describe('费用明细列表'),
  totalAmount: z.coerce.number().describe('总金额，单位：元'),
  reason:   z.string().describe('报销事由，20字以内'),
  dept:     z.string().optional().describe('报销部门'),
  // 异常检测
  warnings: z.array(z.string()).default([])
    .describe('发现的异常或需要注意的地方，如金额超标、信息不全等'),
})

export async function parseExpenseForm(text) {
  const today = new Date().toISOString().slice(0, 10)

  const result = await invokeStructuredOrJson(
    ExpenseSchema,
    [
    {
      role: 'system',
      content: `你是报销单填写助手。从用户的自然语言描述中提取报销信息，生成结构化表单。
今天是 ${today}。
规则：
1. 如果用户说"上周"，根据今天日期推算具体日期
2. 金额务必精确，提到"约""大概"时保留原数字
3. 如果描述中有金额超过单笔3000元的项目，在 warnings 里提示
4. 如果报销事由不明确，在 warnings 里提示需要补充
5. totalAmount 等于所有 items 的 amount 之和`,
    },
    { role: 'user', content: text },
    ],
    {
      jsonSpecHint: `输出示例（字段名必须一致）：\n` +
        `{\n` +
        `  "type": "travel",\n` +
        `  "items": [{"name":"高铁票","amount":123.45,"date":"${today}","note":""}],\n` +
        `  "totalAmount": 123.45,\n` +
        `  "reason": "客户拜访",\n` +
        `  "dept": "",\n` +
        `  "warnings": []\n` +
        `}`,
    }
  )

  return result
}

// ── 请假申请解析 ──────────────────────────────────────────────
const LeaveSchema = z.object({
  type: z.enum(['annual', 'personal', 'sick', 'compensatory', 'marriage', 'maternity'])
    .describe('假期类型：annual=年假, personal=事假, sick=病假, compensatory=调休, marriage=婚假, maternity=产假'),
  startDate: z.string().describe('开始日期，格式 YYYY-MM-DD'),
  endDate:   z.string().describe('结束日期，格式 YYYY-MM-DD'),
  days:      z.coerce.number().describe('请假天数（自然日）'),
  workdays:  z.coerce.number().describe('工作日天数（排除周末）'),
  reason:    z.string().describe('请假原因，30字以内'),
  // 额外信息
  emergencyContact: z.string().optional().describe('紧急联系人（如果提到）'),
  warnings: z.array(z.string()).default([])
    .describe('需要注意的地方，如超过年假余额、需要双重审批等'),
})

export async function parseLeaveForm(text) {
  const today = new Date().toISOString().slice(0, 10)

  // 计算两日期之间的工作日数
  function countWorkdays(startStr, endStr) {
    const start = new Date(startStr)
    const end   = new Date(endStr)
    let count   = 0
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay()
      if (day !== 0 && day !== 6) count++
    }
    return count
  }

  const result = await invokeStructuredOrJson(
    LeaveSchema,
    [
    {
      role: 'system',
      content: `你是请假申请助手。从用户的自然语言描述中提取请假信息。
今天是 ${today}。
规则：
1. "下周一到周三"等相对日期要换算成具体日期
2. days 是自然日（含周末），workdays 是工作日（不含周末）
3. 请假超过3个工作日时，在 warnings 里提示需要主管和 HR 双重审批
4. 病假要在 warnings 里提示需要提供医院证明
5. 产假/婚假要在 warnings 里提示需要提供相关证明材料`,
    },
    { role: 'user', content: text },
    ],
    {
      jsonSpecHint: `输出示例（字段名必须一致）：\n` +
        `{\n` +
        `  "type": "annual",\n` +
        `  "startDate": "${today}",\n` +
        `  "endDate": "${today}",\n` +
        `  "days": 1,\n` +
        `  "workdays": 1,\n` +
        `  "reason": "事假",\n` +
        `  "emergencyContact": "",\n` +
        `  "warnings": []\n` +
        `}`,
    }
  )

  // 自动计算工作日（补充模型可能算错的情况）
  if (result.startDate && result.endDate) {
    result.workdays = countWorkdays(result.startDate, result.endDate)
  }

  return result
}

// ── 报销金额合规检查 ──────────────────────────────────────────
// 公司报销标准（模拟数据，实际从数据库读取）
const EXPENSE_RULES = {
  travel: {
    hotelPerNight:  800,  // 酒店单晚上限
    mealPerDay:     200,  // 餐饮日上限
    flightEconomy:  true, // 必须经济舱
    maxSingleItem: 5000,  // 单笔最大报销金额
  },
  meal:     { maxSingleItem: 500 },
  office:   { maxSingleItem: 1000 },
  training: { maxSingleItem: 10000 },
  other:    { maxSingleItem: 2000 },
}

export function checkCompliance(expenseForm) {
  const alerts = []
  const rules  = EXPENSE_RULES[expenseForm.type] || EXPENSE_RULES.other

  expenseForm.items.forEach(item => {
    if (item.amount > rules.maxSingleItem) {
      alerts.push(`"${item.name}" ¥${item.amount} 超过单笔限额 ¥${rules.maxSingleItem}，需要额外说明`)
    }

    if (expenseForm.type === 'travel') {
      if (item.name.includes('住宿') && item.amount > rules.hotelPerNight * 3) {
        alerts.push(`住宿费用偏高，每晚标准为 ¥${rules.hotelPerNight}`)
      }
    }
  })

  return alerts
}
