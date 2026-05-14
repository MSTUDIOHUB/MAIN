# PHASE 2 — Memory / Repo Index / Eval Harness

## 目标

让 MAIN 具备：

- repository grounding
- long-term memory
- evaluation harness

## Repository Indexing

新增：

```txt
src-tauri/src/indexer/
```

必须：

- symbol index
- import graph
- dependency graph
- embeddings

推荐：

- tree-sitter
- ripgrep
- tantivy
- sqlite

## Session Memory

新增：

```txt
src-tauri/src/memory/
```

记录：

- build flow
- package manager
- repo structure
- previous failures

## Reflection System

Agent 失败后必须：

- 总结错误
- 调整策略
- 避免重复失败

## Eval Harness

新增：

```txt
benchmark/
├── bugfix/
├── refactor/
├── planning/
└── long_horizon/
```

必须支持：

```bash
main eval
```

## Metrics

统计：

- success rate
- retry rate
- hallucination rate
- avg latency
- avg tool calls