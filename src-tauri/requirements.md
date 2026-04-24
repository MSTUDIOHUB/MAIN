# 取款：歧路旅人 - CTB回合制战斗系统需求规格

## 1. 概述 (Overview)
本项目旨在为《歧路旅人》提供一个高度模块化、可扩展的CTB（Turn-Based Combat）战斗系统框架。该系统必须支持回合制战斗流程，并利用Unity的ScriptableObject机制实现数据驱动，确保战斗逻辑与数据表现的分离。

## 2. 核心目标 (Goals)
- 实现一个清晰的战斗流程控制（Turn Management）。
- 将所有战斗数据（角色属性、技能效果、敌人AI等）从代码中剥离，放入可配置的数据资产中。
- 确保战斗逻辑的可测试性和可扩展性，未来能轻松添加新机制（如状态效果、特殊回合）。

## 3. 范围界定 (Scope Definition)
**本次框架搭建阶段（Phase 1）的范围包括：**
- 角色基础数据结构（角色、属性）。
- 战斗流程控制器的骨架（BattleManager）。
- 技能/行动的抽象层（Action/Skill）。
- 战斗回合的驱动机制。

**本次框架搭建阶段（Phase 1）的范围不包括（Out of Scope）：**
- 复杂的AI决策树（敌人行为）。
- 完整的UI/UX实现（仅需提供数据驱动的接口）。
- 复杂的物理碰撞或动画同步。

## 4. 需求规格 (Requirements - EARS)

### 4.1. 战斗流程管理 (Battle Flow)
- [REQ-001] WHEN 双方进入战斗状态时，THE SYSTEM SHALL 初始化战斗数据并进入等待回合开始状态。
- [REQ-002] WHEN 双方的行动序列（Action Sequence）全部执行完毕，THE SYSTEM SHALL 判定战斗结果（胜利/失败/平局）。
- [REQ-003] WHEN 当前回合的行动序列执行完毕，THE SYSTEM SHALL 切换到下一个回合的行动序列，直到战斗结束或进入等待状态。

### 4.2. 数据驱动 (Data Driven)
- [REQ-004] WHEN 需要定义一个角色时，THE SYSTEM SHALL 使用 `CharacterData` ScriptableObject 来定义其所有基础属性（HP, MaxHP, Attack, Defense, 等）。
- [REQ-005] WHEN 需要定义一个技能时，THE SYSTEM SHALL 使用 `SkillData` ScriptableObject 来定义其效果、消耗和触发条件。
- [REQ-006] WHEN 战斗需要一个特定的情境或剧本时，THE SYSTEM SHALL 使用 `BattleScenario` ScriptableObject 来编排本次战斗的初始条件和行动顺序。

### 4.3. 战斗执行 (Combat Execution)
- [REQ-007] WHEN 玩家选择一个行动（Skill/Item）时，THE SYSTEM SHALL 验证该行动的可行性（如：冷却时间、资源消耗、目标有效性）。
- [REQ-008] WHEN 行动被执行，THE SYSTEM SHALL 根据 `SkillData` 中定义的逻辑，计算并应用效果（如：伤害计算、状态施加）。

## 5. 验收标准 (Acceptance Criteria)
- 必须能够成功实例化一个 `BattleManager` 并驱动一个模拟回合的流程。
- 所有核心数据结构（角色、技能）必须是可序列化的数据资产（ScriptableObject）。
- 战斗流程必须是可追踪的，即可以通过日志记录追踪到哪个阶段触发了哪个事件。