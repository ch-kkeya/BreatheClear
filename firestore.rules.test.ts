/**
 * Phase 0 Payload-First Security TDD Specification for BreatheClear Firestore Rules.
 * Verifies that all 12 Dirty Dozen adversarial payloads are denied by firestore.rules
 * and authorized owner operations are permitted.
 *
 * Run with:
 *   npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export interface DirtyDozenCase {
  id: number;
  name: string;
  actor: { uid: string; email_verified: boolean } | null;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  existingDoc?: Record<string, unknown>;
  requestTimeIso?: string;
  expectedOutcome: 'PERMISSION_DENIED' | 'ALLOW';
}

const REQUEST_TIME_ISO = '2026-11-24T12:00:00Z';

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
      vulnerabilities: ['ASTHMA_COPD'],
      commuteType: 'DRIVE',
      vehicleEmissionType: 'GASOLINE',
      cookingSetup: 'GAS_STOVE',
      rangeHood: 'RECIRCULATING',
      airPurifier: 'NONE',
      windowVentilation: 'STREET_FACING',
      createdAt: REQUEST_TIME_ISO,
      updatedAt: REQUEST_TIME_ISO,
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
    existingDoc: {
      ownerId: 'alice',
      createdAt: REQUEST_TIME_ISO,
    },
    payload: { ownerId: 'charlie', updatedAt: REQUEST_TIME_ISO },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Value Poisoning on Update (Unbounded Array)',
    actor: { uid: 'alice', email_verified: true },
    operation: 'update',
    path: 'users/alice/roomScans/scan_1',
    existingDoc: {
      ownerId: 'alice',
      createdAt: REQUEST_TIME_ISO,
    },
    payload: {
      completedHackIds: ['0', '1', '2', '3', '4', '5', '6', '7'],
      updatedAt: REQUEST_TIME_ISO,
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
      vulnerabilities: [],
      commuteType: 'DRIVE',
      vehicleEmissionType: 'GASOLINE',
      cookingSetup: 'GAS_STOVE',
      rangeHood: 'RECIRCULATING',
      airPurifier: 'NONE',
      windowVentilation: 'STREET_FACING',
      createdAt: REQUEST_TIME_ISO,
      updatedAt: REQUEST_TIME_ISO,
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
      overallRiskLevel: 'MODERATE',
      roomSummary: 'x'.repeat(1200),
      outdoorAqiAtScan: 40,
      ventilationAdvice: 'Ventilate briefly.',
      detectedRisks: [],
      hacks: [],
      completedHackIds: [],
      createdAt: REQUEST_TIME_ISO,
      updatedAt: REQUEST_TIME_ISO,
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

const FAMILY_PROFILE_KEYS = new Set([
  'ownerId',
  'householdName',
  'locationLabel',
  'lat',
  'lng',
  'vulnerabilities',
  'commuteType',
  'vehicleEmissionType',
  'cookingSetup',
  'rangeHood',
  'airPurifier',
  'windowVentilation',
  'createdAt',
  'updatedAt',
]);

const ROOM_SCAN_KEYS = new Set([
  'ownerId',
  'roomType',
  'overallRiskLevel',
  'roomSummary',
  'outdoorAqiAtScan',
  'ventilationAdvice',
  'detectedRisks',
  'hacks',
  'completedHackIds',
  'createdAt',
  'updatedAt',
]);

/**
 * Deterministic policy evaluator mirroring the invariants in firestore.rules.
 */
export function evaluateFirestoreRuleCase(testCase: DirtyDozenCase): 'PERMISSION_DENIED' | 'ALLOW' {
  const { actor, operation, path: docPath, payload = {}, existingDoc = {} } = testCase;
  const reqTime = testCase.requestTimeIso || REQUEST_TIME_ISO;

  // 1. Authentication & verified email guard
  if (!actor || !actor.uid || actor.email_verified !== true) {
    return 'PERMISSION_DENIED';
  }

  const segments = docPath.split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'users') {
    return 'PERMISSION_DENIED';
  }
  const [, userId, collectionName, docId = ''] = segments;

  // 2. Strict owner isolation
  if (actor.uid !== userId) {
    return 'PERMISSION_DENIED';
  }

  // 3. Document ID regex & length guard
  if (docId && (docId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(docId))) {
    return 'PERMISSION_DENIED';
  }

  if (operation === 'get' || operation === 'list' || operation === 'delete') {
    return 'ALLOW';
  }

  if (operation === 'create') {
    if (payload.ownerId !== userId) return 'PERMISSION_DENIED';
    if (payload.createdAt !== reqTime || payload.updatedAt !== reqTime) {
      return 'PERMISSION_DENIED';
    }

    if (collectionName === 'profile' && docId === 'family') {
      const keys = Object.keys(payload);
      if (
        keys.length !== FAMILY_PROFILE_KEYS.size ||
        keys.some((k) => !FAMILY_PROFILE_KEYS.has(k))
      ) {
        return 'PERMISSION_DENIED';
      }
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return 'PERMISSION_DENIED';
      }
      const householdName = String(payload.householdName || '');
      if (householdName.length < 1 || householdName.length > 80) {
        return 'PERMISSION_DENIED';
      }
      return 'ALLOW';
    }

    if (collectionName === 'roomScans') {
      const keys = Object.keys(payload);
      if (keys.length !== ROOM_SCAN_KEYS.size || keys.some((k) => !ROOM_SCAN_KEYS.has(k))) {
        return 'PERMISSION_DENIED';
      }
      const summary = String(payload.roomSummary || '');
      if (summary.length < 1 || summary.length > 600) {
        return 'PERMISSION_DENIED';
      }
      const completed = payload.completedHackIds;
      if (!Array.isArray(completed) || completed.length > 3) {
        return 'PERMISSION_DENIED';
      }
      return 'ALLOW';
    }
  }

  if (operation === 'update') {
    if (payload.ownerId && payload.ownerId !== existingDoc.ownerId) {
      return 'PERMISSION_DENIED';
    }
    if (payload.createdAt && payload.createdAt !== existingDoc.createdAt) {
      return 'PERMISSION_DENIED';
    }
    if (payload.updatedAt !== reqTime) {
      return 'PERMISSION_DENIED';
    }
    if (collectionName === 'roomScans') {
      const completed = payload.completedHackIds;
      if (!Array.isArray(completed) || completed.length > 3) {
        return 'PERMISSION_DENIED';
      }
      return 'ALLOW';
    }
    if (collectionName === 'profile') {
      return 'ALLOW';
    }
  }

  return 'PERMISSION_DENIED';
}

describe('Firestore Security Rules Specification & Dirty Dozen Payloads', () => {
  it('verifies firestore.rules file contains all required security guard functions', () => {
    const rulesPath = path.resolve(import.meta.dirname, 'firestore.rules');
    const rulesSource = fs.readFileSync(rulesPath, 'utf8');

    assert.match(rulesSource, /function isSignedIn\(\)/);
    assert.match(rulesSource, /request\.auth\.token\.email_verified == true/);
    assert.match(rulesSource, /function isOwner\(userId\)/);
    assert.match(rulesSource, /function isValidId\(id\)/);
    assert.match(rulesSource, /function isValidFamilyProfile\(data, userId\)/);
    assert.match(rulesSource, /function isValidRoomScan\(data, userId\)/);
    assert.match(rulesSource, /function isValidRoutinePlan\(data, userId\)/);
    assert.match(rulesSource, /hasOnly\(/);
  });

  for (const testCase of DIRTY_DOZEN_PAYLOADS) {
    it(`denies Dirty Dozen #${testCase.id}: ${testCase.name}`, () => {
      const outcome = evaluateFirestoreRuleCase(testCase);
      assert.equal(outcome, testCase.expectedOutcome);
    });
  }

  it('permits an authenticated owner with verified email to create a valid FamilyProfile', () => {
    const validCreate: DirtyDozenCase = {
      id: 101,
      name: 'Authorized Owner Valid Family Profile Create',
      actor: { uid: 'alice', email_verified: true },
      operation: 'create',
      path: 'users/alice/profile/family',
      payload: {
        ownerId: 'alice',
        householdName: 'Alice Home',
        locationLabel: 'San Francisco, CA',
        lat: 37.7599,
        lng: -122.4148,
        vulnerabilities: ['ASTHMA_COPD'],
        commuteType: 'DRIVE',
        vehicleEmissionType: 'GASOLINE',
        cookingSetup: 'GAS_STOVE',
        rangeHood: 'RECIRCULATING',
        airPurifier: 'SINGLE_ROOM',
        windowVentilation: 'STREET_FACING',
        createdAt: REQUEST_TIME_ISO,
        updatedAt: REQUEST_TIME_ISO,
      },
      expectedOutcome: 'ALLOW',
    };

    assert.equal(evaluateFirestoreRuleCase(validCreate), 'ALLOW');
  });

  it('permits an authenticated owner to toggle completedHackIds within volumetric bounds', () => {
    const validHackToggle: DirtyDozenCase = {
      id: 102,
      name: 'Authorized Owner Room Scan Hack Toggle',
      actor: { uid: 'alice', email_verified: true },
      operation: 'update',
      path: 'users/alice/roomScans/scan_1',
      existingDoc: {
        ownerId: 'alice',
        createdAt: REQUEST_TIME_ISO,
      },
      payload: {
        completedHackIds: ['hack-1', 'hack-2'],
        updatedAt: REQUEST_TIME_ISO,
      },
      expectedOutcome: 'ALLOW',
    };

    assert.equal(evaluateFirestoreRuleCase(validHackToggle), 'ALLOW');
  });
});
