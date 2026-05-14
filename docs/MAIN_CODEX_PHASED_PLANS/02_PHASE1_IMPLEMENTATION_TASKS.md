# PHASE 1 实施任务（Codex 直接执行）

## TASK 1 — Trace Recorder

新增：

```txt
.MAIN/traces/
src-tauri/src/harness/tracing.rs
```

Trace 格式：

```json
{
  "task_id": "...",
  "step_id": "...",
  "tool_call": "...",
  "stdout": "...",
  "stderr": "...",
  "verification": "...",
  "latency_ms": 0
}
```

必须：

- JSON 存储
- 每 step 单独 trace
- 支持 replay

---

## TASK 2 — Permission Layer

新增：

```txt
.MAIN/permissions.yaml
```

示例：

```yaml
shell:
  allow:
    - ls
    - rg
    - cargo test

  deny:
    - sudo
    - rm -rf /
```

所有 shell command：

必须经过：

```rust
permission_guard.validate()
```

---

## TASK 3 — Verifier

新增：

```txt
src-tauri/src/runtime/verifier.rs
```

支持：

- cargo check
- cargo test
- npm run build
- npm run lint

必须：

- async
- timeout
- structured result

---

## TASK 4 — Context Manager

新增：

```txt
src-tauri/src/runtime/context.rs
```

必须维护：

- active files
- recent steps
- working memory
- summaries
- mistakes

---

## TASK 5 — Event Bus

新增：

```rust
emit("task_started");
emit("tool_called");
emit("verification_failed");
emit("retry_started");
emit("task_completed");
```

所有 tracing / UI / analytics 统一监听。