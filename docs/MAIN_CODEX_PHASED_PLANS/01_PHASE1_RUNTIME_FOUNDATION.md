# PHASE 1 — Runtime Harness Foundation

## 目标

将 MAIN 从：

User → Prompt → Tool

升级为：

Plan → Execute → Observe → Verify → Retry

## 本阶段必须实现

- runtime loop
- trace recorder
- verifier
- permissions
- context manager

## 严格限制

不允许：

- 重写 UI
- 重写 Tauri
- 推翻 Session
- 推翻 Plan/Execute
- 重构 React

必须：

- 增量式修改
- Rust-first
- tokio async
- 可测试
- 可 replay

## 新增目录

```txt
src-tauri/src/runtime/
src-tauri/src/harness/
```

## 新增文件

```txt
runtime/
├── loop.rs
├── context.rs
├── verifier.rs
├── retry.rs
└── event_bus.rs

harness/
├── tracing.rs
└── permissions.rs
```

## Runtime Loop

实现：

```rust
loop {
    let context = context_manager.build();

    let plan = planner.next_step(context);

    let action = executor.execute(plan).await;

    let observation = observer.observe(action);

    let verification = verifier.verify(observation);

    tracer.record(...);

    if verification.success {
        break;
    }

    retry_policy.handle();
}
```

## 验收标准

必须支持：

- 多 step 执行
- trace logging
- verification
- retry
- context state

不允许：

- 单轮 prompt tool call