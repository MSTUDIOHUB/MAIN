# AI Max Codex Gateway

这是一个独立的 OpenAI Responses 兼容网关，用来把你的云端自定义流式 HTTP API 包装成 Codex 可以直接使用的 `/v1/responses` 服务。

## 快速开始

1. 复制环境变量示例：

```bash
cp .env.example .env
```

2. 修改 `.env`：

```env
UPSTREAM_BASE_URL=https://your-cloud-model.example.com
UPSTREAM_PATH=/chat/completions
UPSTREAM_API_KEY=your-upstream-key
UPSTREAM_MODEL=ai-max-cloud
PORT=8787
```

3. 启动网关：

```bash
node cloud-gateway/aimax/server.mjs
```

4. 检查服务：

```bash
curl http://127.0.0.1:8787/health
```

## Codex 配置示例

把下面配置加入 Codex 配置文件：

```toml
model_provider = "aimax"
model = "ai-max-cloud"

[model_providers.aimax]
name = "AI Max Cloud"
base_url = "http://127.0.0.1:8787/v1"
env_key = "AIMAX_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 300000
```

本地可以设置任意非空 key：

```bash
export AIMAX_API_KEY=local-dev-key
```

## 上游接口约定

默认会向上游发送 OpenAI Chat Completions 风格请求：

```json
{
  "model": "ai-max-cloud",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "temperature": 0.2,
  "max_tokens": 4096
}
```

流式响应支持以下常见格式：

```text
data: {"choices":[{"delta":{"content":"你好"}}]}

data: {"text":"你好"}

data: [DONE]
```

如果你的云端 API 字段不同，只需要修改 `adapter.mjs` 中的请求体构造和增量文本提取逻辑。

## 当前范围

- 已支持：文本输入、文本输出、非流式响应、SSE 流式响应、上游错误转换、长连接保活。
- 暂不支持：图片、文件、工具调用、Claude Messages 协议。
