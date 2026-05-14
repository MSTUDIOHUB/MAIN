# PHASE 3 — Multi-Agent + MCP Runtime Mesh

## 目标

将 MAIN 升级为：

Universal Tool Runtime

而不是：

Coding Assistant

## 多 Agent Runtime

新增：

```txt
planner/
executor/
critic/
```

分工：

- Planner → 任务拆分
- Executor → 执行工具
- Critic → 检查 hallucination

## Task Graph Runtime

新增：

```txt
task_graph.rs
```

支持：

- DAG execution
- parallel execution
- dependency scheduling

## MCP Runtime Mesh

新增：

```txt
src-tauri/src/mcp/
```

结构：

```txt
mcp/
├── unity.rs
├── browser.rs
├── git.rs
├── filesystem.rs
└── terminal.rs
```

MCP 必须：

- 标准化 tool interface
- permission-aware
- trace-aware
- replay-aware