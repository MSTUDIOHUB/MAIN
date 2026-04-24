---
inclusion: fileMatch
fileMatchPattern: ["**/*.cs", "**/*.unity"]
---

# Unity Memory Management & GC Minimization

## Core Principle
Unity's Boehm GC runs on the main thread and causes frame hitches when large heaps accumulate. The primary strategy is **zero allocation in hot paths**.

## Allocation-Free Hot Paths
- `Update`, `FixedUpdate`, `LateUpdate`, and coroutine `MoveNext` must not allocate.
- Cache references in `Awake` / `Start`; never call `GetComponent<T>()` in Update loops.
- Avoid `foreach` on custom collections — it boxes the enumerator. Use `for` or `List<T>.ForEach` instead.
- String concatenation in loops → use `StringBuilder` or pre-allocate.

## Object Pooling
- Pool all frequently instantiated/destroyed objects: bullets, VFX, enemies, UI list items.
- Implement via `UnityEngine.Pool.ObjectPool<T>` (Unity 2021+) or a custom stack-based pool.
- Pool size: warm up with expected peak count at scene load; allow overflow with `collectionCheck = true` in editor.
- Reset pooled objects: deactivate GameObject, zero velocities, reset health/state.

## Avoid Hidden Allocations
- `params object[]` → boxes value types. Use generic overloads instead.
- `Action` / `Func` captures → allocate closures. Cache delegates as fields.
- `LINQ` (.Where, .Select) → allocate enumerators. Use `for` loops in hot paths.
- `Debug.Log($"...")` → interpolated strings allocate. Use `Debug.LogFormat` or conditionally compile out.

## SO & Asset Loading
- Use `ScriptableObject` for static data tables; load once, reference everywhere.
- `Addressables` for dynamic content; release assets when no longer needed.
- Avoid `Resources.Load` in production — it increases build size and cannot be unloaded selectively.

## Struct vs Class
- Use `struct` for small, short-lived data (damage events, coordinates, color presets).
- Keep structs **≤ 16 bytes** to avoid copy overhead.
- Never mutate a struct property via interface — it boxes and mutates a copy.

## Profiling
- Profile with **Memory Profiler** package and **Deep Profile** in editor.
- Target: ≤ 0 B allocation per frame in gameplay loops; ≤ 1 KB/frame during loading screens.
