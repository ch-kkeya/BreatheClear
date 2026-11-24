/**
 * Phase 0 Payload-First Security TDD Specification for BreatheClear Firestore Rules.
 * Verifies that all 12 Dirty Dozen adversarial payloads are denied by firestore.rules.
 *
 * Run against the Firebase Emulator Suite if installed:
 *   npx tsx firestore.rules.test.ts
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  actor: { uid: string; email_verified: boolean } | null;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Profile Read',
    actor: null,
    operation: 'get',
    path: 'users/alice/profile/family',
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-User PII Read',
    actor: { uid: 'bob', email_verified: true },
    operation: 'get',
    path: 'users/alice/profile/family',
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Unverified Email Write',
    actor: { uid: 'alice', email_verified: false },
    operation: 'create',
    path: 'users/alice/profile/family',
    payload: { ownerId: 'alice', householdName: 'Alice Home' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Owner Identity Spoofing',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: 'users/alice/profile/family',
    payload: { ownerId: 'bob', householdName: 'Spoofed' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow / Ghost Field Injection',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: 'users/alice/profile/family',
    payload: {
      ownerId: 'alice',
      householdName: 'Alice Home',
      locationLabel: 'San Francisco, CA',
      lat: 37.7749,
      lng: -122.4194,
      vulnerabilities: ['ASTHMA'],
      commuteType: 'DRIVE',
      vehicleEmissionType: 'GASOLINE',
      cookingSetup: 'GAS_STOVE',
      rangeHood: 'RECIRCULATING',
      airPurifier: 'NONE',
      windowVentilation: 'STREET_FACING',
      isAdmin: true,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Path ID Poisoning (Oversized ID)',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: `users/alice/roomScans/${'a'.repeat(200)}`,
    payload: { ownerId: 'alice', roomType: 'KITCHEN' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Client Timestamp Forgery',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: 'users/alice/roomScans/scan_forged_time',
    payload: {
      ownerId: 'alice',
      roomType: 'KITCHEN',
      overallRiskLevel: 'MODERATE',
      roomSummary: 'Gas stove visible.',
      outdoorAqiAtScan: 42,
      ventilationAdvice: 'Crack window for 10 min.',
      detectedRisks: [],
      hacks: [],
      completedHackIds: [],
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immutable Field Tampering on Update',
    actor: { uid: 'alice', email_verified: true },
    operation: 'update',
    path: 'users/alice/profile/family',
    payload: { ownerId: 'charlie' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Value Poisoning on Update (Unbounded Array)',
    actor: { uid: 'alice', email_verified: true },
    operation: 'update',
    path: 'users/alice/roomScans/scan_1',
    payload: {
      completedHackIds: ['0', '1', '2', '3', '4', '5', '6', '7'],
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Out-of-Bounds Coordinates',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: 'users/alice/profile/family',
    payload: {
      ownerId: 'alice',
      householdName: 'Invalid Geo',
      locationLabel: 'Nowhere',
      lat: 999,
      lng: -400,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'String Volumetric Exhaustion',
    actor: { uid: 'alice', email_verified: true },
    operation: 'create',
    path: 'users/alice/roomScans/scan_huge',
    payload: {
      ownerId: 'alice',
      roomType: 'KITCHEN',
      roomSummary: 'x'.repeat(1200),
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Cross-User List Scraping',
    actor: { uid: 'bob', email_verified: true },
    operation: 'list',
    path: 'users/alice/routinePlans',
    expectedOutcome: 'PERMISSION_DENIED',
  },
];
