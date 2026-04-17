# WorkMind AI — 智能办公 Agent 平台

基于 Vue3 + Node.js + LangChain.js + DeepSeek 构建的智能办公 Agent 系统。

## 项目模块

| 模块 | 说明 | 状态 |
|------|------|------|
| 智能对话助手 | 多轮对话 / 流式输出 / 用户画像 | ✅ 已完成 |
| 知识库问答   | 文档上传 / RAG 检索 / 来源标注 | ✅ 已完成 |
| 任务 Agent   | Function Call / ReAct / 工具可视化 | ✅ 已完成 |
| 内容工作流   | 周报/纪要/邮件/PRD 工作流 | ✅ 已完成 |
| ERP 报销请假 | 智能填单 / Multi-Agent 审批 | ✅ 已完成 |
| Prompt 调试  | A/B测试 / 版本管理 | ✅ 已完成 |
| 用量看板     | Token消耗 / 费用 / 缓存统计 | ✅ 已完成 |

## 技术栈

- **前端**：Vue3 + Vite + Pinia + Vue Router
- **后端**：Node.js + Express
- **AI 框架**：LangChain.js + LangGraph
- **模型**：DeepSeek（对话）/ OpenAI（Embedding）
- **向量库**：Chroma
- **部署**：Docker + docker-compose

## 快速启动

### 1. 克隆项目

```bash
git clone <repo-url>
cd workmind
```

### 2. 配置环境变量

```bash
cd server
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
```

### 3. 启动后端

```bash
cd server
npm install
npm run dev
```

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev
# 页面打开在 http://localhost:5173
```

### 5. （可选）启动向量数据库（RAG 功能需要）

```bash
docker run -d -p 8006:8000 --name workmind-chroma chromadb/chroma
docker stop workmind-chroma
查看是否已停
docker ps --filter "name=workmind-chroma"

之后再启动
docker start workmind-chroma

彻底删除容器（下次需重新 run）
docker rm workmind-chroma
```

### 6. 一键 Docker 部署（后端+向量数据库）

```bash
cp server/.env.example .env
# 填入 Key

docker-compose up -d --build
```

## 项目结构

```
workmind/
├── frontend/               Vue3 前端
│   ├── src/
│   │   ├── views/          各模块页面
│   │   ├── components/     UI 组件
│   │   ├── stores/         Pinia 状态
│   │   ├── composables/    组合式函数
│   │   ├── utils/          工具（http、sse）
│   │   └── styles/         全局样式
│   └── vite.config.js
│
├── server/                 Node.js 后端
│   ├── src/
│   │   ├── routes/         API 路由
│   │   ├── services/       业务逻辑
│   │   ├── middleware/      中间件
│   │   ├── utils/          工具（日志、错误）
│   │   └── config/         配置管理
│   └── Dockerfile
│
└── docker-compose.yml
```
