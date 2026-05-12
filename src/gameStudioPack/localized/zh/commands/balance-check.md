---
name: balance-check
description: "分析数值、成长、资源或战斗平衡，发现异常和失衡点。"
argument-hint: "[system-name|path-to-data-file]"
user-invocable: true
allowed-tools: Read, Glob, Grep
agent: economy-designer
---

## 阶段 1: Identify Balance Domain

Determine the balance domain from `$ARGUMENTS[0]`:

- **Combat** → weapon/ability DPS, time-to-kill, damage type interactions
- **Economy** → resource faucets/sinks, acquisition rates, item pricing
- **Progression** → XP/power curves, dead zones, power spikes
- **Loot** → rarity distribution, pity timers, inventory pressure
- **File path given** → load that file directly and infer domain from content

If no argument, ask the user which system to check.

---

## 阶段 2: Read Data Files

Read relevant files from `assets/data/` and `design/balance/` for the identified domain.
Note every file read — they will appear in the Data Sources section of the report.

---

## 阶段 3: Read Design Document

Read the GDD for the system from `design/gdd/` to understand intended design targets,
tuning knobs, and expected value ranges. This is the baseline for "correct" behaviour.

---

## 阶段 4: Perform Analysis

Run domain-specific checks:

**Combat balance:**
- Calculate DPS for all weapons/abilities at each power tier
- 检查 time-to-kill at each tier
- Identify any options that dominate all others (strictly better)
- 检查 if defensive options can create unkillable states
- Verify damage type/resistance interactions are balanced

**Economy balance:**
- Map all resource faucets and sinks with flow rates
- Project resource accumulation over time
- 检查 for infinite resource loops
- Verify gold sinks scale with gold generation
- 检查 if any items are never worth purchasing

**Progression balance:**
- Plot the XP curve and power curve
- 检查 for dead zones (no meaningful progression for too long)
- 检查 for power spikes (sudden jumps in capability)
- Verify content gates align with expected player power
- 检查 if skip/grind strategies break intended pacing

**Loot balance:**
- Calculate expected time to acquire each rarity tier
- 检查 pity timer math
- Verify no loot is strictly useless at any stage
- 检查 inventory pressure vs acquisition rate

---

## 阶段 5: Output the Analysis

```
## Balance 检查: [System Name]

### Data Sources Analyzed
- [List of files read]

### Health Summary: [HEALTHY / CONCERNS / CRITICAL ISSUES]

### Outliers Detected
| Item/Value | Expected Range | Actual | Issue |
|-----------|---------------|--------|-------|

### Degenerate Strategies Found
- [Strategy description and why it is problematic]

### Progression Analysis
[Graph description or table showing progression curve health]

### 建议
| Priority | Issue | Suggested Fix | Impact |
|----------|-------|--------------|--------|

### Values That Need Attention
[Specific values with suggested adjustments and rationale]
```

---

## 阶段 6: Fix & Verify Cycle

After presenting the report, ask:

> "Would you like to fix any of these balance issues now?"

If yes:
- Ask which issue to address first (refer to the Recommendations table by priority row)
- Guide the user to update the relevant data file in `assets/data/` or formula in `design/balance/`
- After each fix, offer to re-run the relevant balance checks to verify no new outliers were introduced
- If the fix changes a tuning knob defined in a GDD or referenced by an ADR, remind the user:
  > "This value is defined in a design document. Run `/propagate-design-change [path]` on the affected GDD to find downstream impacts before committing."

If no:
- Summarize open issues and suggest saving the report to `design/balance/balance-check-[system]-[date].md` for later

End with:
> "Re-run `/balance-check` after fixes to verify."
