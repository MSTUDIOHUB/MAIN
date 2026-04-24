---
inclusion: fileMatch
fileMatchPattern: ["**/*.cs", "**/*.unity", "**/*.prefab"]
---

# Unity Physics & Collision Best Practices

## Layer-Based Collision Matrix
- Configure collision pairs in **Edit → Project Settings → Physics → Layer Collision Matrix**.
- Static environment → `Default` layer; dynamic objects → dedicated layers (e.g., `Player`, `Enemy`, `Projectile`).
- Never leave unused layer pairs enabled — every extra pair adds broadphase overhead.

## Rigidbody Rules
- **Kinematic RB** for objects moved by code (e.g., character controllers, platforms).
- **Dynamic RB** only for objects that need physics simulation (ragdolls, debris).
- Never move a dynamic RB via `transform.position` — always use `rb.velocity`, `rb.AddForce`, or `rb.MovePosition`.
- Set `interpolation = Interpolate` on player-controlled RBs to eliminate jitter.

## Collider Guidelines
- Use **primitive colliders** (Box, Sphere, Capsule) for gameplay objects.
- Reserve **MeshColliders** for static environment geometry only; mark them `convex = true` when used as triggers or with dynamic RBs.
- Compound colliders (multiple primitives on child objects) > single MeshCollider for characters.
- Avoid `isTrigger = true` on objects that also need physical response; separate into two GameObjects.

## FixedUpdate vs Update
- All physics reads/writes must occur in `FixedUpdate`.
- Use `Time.fixedDeltaTime` for physics calculations, never `Time.deltaTime`.
- For cross-frame smoothing (camera follow), read physics state in `FixedUpdate` and interpolate in `LateUpdate`.

## Performance
- Prefer `Physics.OverlapSphere` / `Physics.Raycast` over `OnCollisionEnter` when you only need point queries.
- Disable `autoSyncTransforms` in Physics settings; call `Physics.SyncTransforms()` manually when mixing transform and physics moves.
- Use `PhysicsScene` for off-screen simulation or server-authoritative logic.

## 2D Specifics
- Use `Rigidbody2D` with `CollisionDetectionMode2D.Continuous` for fast-moving projectiles.
- `Physics2D.autoSyncTransforms = false` by default; sync manually only when needed.
