# Unity MCP 与 GameDev Runtime 方案

## 目标

MAIN 不只是 coding agent。

还必须支持：

- Unity
- Blender
- GameDev pipelines
- Long-horizon creative workflows

## 为什么需要 Harness

游戏开发是：

- 长任务
- 多工具
- 状态机
- 大量验证

不是简单 prompt。

## 典型工作流

```txt
生成 prefab
↓
修改 shader
↓
更新 animation
↓
运行 Unity
↓
读取 console
↓
自动修复
```

Runtime 必须支持：

- stateful execution
- verification loops
- retry policies
- memory
- task graph

## Unity MCP 必须支持

- scene inspection
- prefab editing
- console reading
- play mode execution
- asset pipeline
- shader iteration

## 长期方向

MAIN 最终应该成为：

```txt
Local Agent Operating Runtime
```

而不是聊天 UI。