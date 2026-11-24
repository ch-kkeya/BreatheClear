# BreatheClear Firestore Security Specification

## 1. Data Invariants

1. **Strict Household PII Isolation**: All family profile data (home address label, latitude/longitude coordinates, health vulnerability selections, cooking/ventilation configuration) lives exclusively under `/users/{userId}/profile/{profileId}` and is readable and writable ONLY by the authenticated owner (`request.auth.uid == userId`).
2. **Verified Identity Ownership**: All write operations (`create`, `update`, `delete`) require an authenticated Google account with `request.auth.token.email_verified == true` and `data.ownerId == request.auth.uid`.
3. **Immutable Ownership & Creation Timestamps**: Once created, `ownerId` and `createdAt` can never be altered on update (`incoming().ownerId == existing().ownerId && incoming().createdAt == existing().createdAt`).
4. **Server-Authoritative Timestamps**: Every `create` mandates `createdAt == request.time && updatedAt == request.time`; every `update` mandates `updatedAt == request.time`.
5. **Bounded Volumetric Limits**: Every string enforces an explicit `.size()` ceiling matching `firebase-blueprint.json`; every array enforces a strict `.size() <= MAX` bound and element type guard; document IDs match `^[a-zA-Z0-9_\-]+$` with `<= 128` characters.
6. **Zero Shadow Fields**: `hasAll` + `hasOnly` on `create` and action-scoped `affectedKeys().hasOnly(...)` on `update` prevent unauthorized ghost fields (e.g., `role`, `isAdmin`, `isVerified`).
7. **Secure List Queries**: `allow list` on `roomScans` and `routinePlans` explicitly asserts `isOwner(userId) && existing().ownerId == request.auth.uid` without `get()` or `exists()` lookups.

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Collection | Malicious Payload / Operation | Expected Result |
|---|---------------|-------------------|-------------------------------|-----------------|
| 1 | Unauthenticated Read | `/users/alice/profile/family` | `get` with `auth == null` | `PERMISSION_DENIED` |
| 2 | Cross-User PII Read | `/users/alice/profile/family` | `get` as `bob` (`email_verified: true`) | `PERMISSION_DENIED` |
| 3 | Unverified Email Write | `/users/alice/profile/family` | `create` as `alice` with `email_verified: false` | `PERMISSION_DENIED` |
| 4 | Owner Identity Spoofing | `/users/alice/profile/family` | `create` with `ownerId: "bob"` | `PERMISSION_DENIED` |
| 5 | Shadow / Ghost Field Injection | `/users/alice/profile/family` | `create` including extra field `isAdmin: true` | `PERMISSION_DENIED` |
| 6 | Path ID Poisoning (1.5KB ID) | `/users/alice/roomScans/<1500 chars>` | `create` with oversized or special-char document ID | `PERMISSION_DENIED` |
| 7 | Client Timestamp Forgery | `/users/alice/roomScans/scan1` | `create` with backdated client `createdAt` instead of `request.time` | `PERMISSION_DENIED` |
| 8 | Immutable Field Tampering | `/users/alice/profile/family` | `update` attempting to mutate `createdAt` or `ownerId` | `PERMISSION_DENIED` |
| 9 | Value Poisoning on Update | `/users/alice/roomScans/scan1` | `update` setting `completedHackIds` to a 20-element array or invalid type | `PERMISSION_DENIED` |
| 10 | Out-of-Bounds Coordinates | `/users/alice/profile/family` | `create` with `lat: 999, lng: -400` | `PERMISSION_DENIED` |
| 11 | String Volumetric Exhaustion | `/users/alice/roomScans/scan1` | `create` with `roomSummary` exceeding 600 chars | `PERMISSION_DENIED` |
| 12 | Cross-User List Scraping | `/users/alice/routinePlans` | `list` query executed as `bob` | `PERMISSION_DENIED` |
