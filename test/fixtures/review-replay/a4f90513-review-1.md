## Findings

1. **Blocking — the lock can expire during the unbounded cascade, reopening the destructive TOCTOU.**  
   [rest-fastify.ts:4012] holds the connection lock while running the entire cascade at lines 4024–4047. That cascade performs repeated whole-store scans/writes per subject ([identity-adapter.js:923]), but the non-renewable lock is considered stale after 30 seconds ([file-lock.js:101]). A large cascade can therefore have its live lock stolen; a PUT can install a replacement while the old delete continues revoking by the same connection ID, after which the delete merely returns 409. The replacement survives, but its credentials may already be revoked—the original failure mode. A reduced-stale-window concurrency probe reproduced live-lock takeover.

2. **Minor — the REST contract no longer describes actual delete outcomes.**  
   The handler now returns 404 when the record is absent at lock time and only returns `removed: 1` on success ([rest-fastify.ts:4050]), while the shared contract still documents a concurrent-delete `200 removed: 0` response ([contracts/rest.js:907]). Its generic 409 schema also does not model the newly returned revocation fields.

Typecheck passed. The focused store test passed; server integration tests could not run in this sandbox because their scratch-home setup received `spawnSync git EPERM`.

```json
{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"server/rest-fastify.ts","summary":"The delete now holds a non-renewable 30-second-stale file lock across an unbounded multi-store revocation cascade; a slow cascade lets another process steal the live lock, replace the connection, and have replacement credentials revoked before the delete returns 409."},{"severity":"minor","file":"server/rest-fastify.ts","summary":"Delete response behavior changed from the documented concurrent 200/removed:0 outcome to 404 or 409, but the shared REST contract was not updated and does not model the new 409 revocation fields."}]}
```

