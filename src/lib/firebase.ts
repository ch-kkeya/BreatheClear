import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import exampleFirebaseConfig from '../../firebase-applet-config.example.json';
import type { FamilyProfile, RoomScanResult, RoutinePlan } from '../types';

type FirebaseAppletConfig = typeof exampleFirebaseConfig;

const localConfigModules = import.meta.glob<{ default: FirebaseAppletConfig }>(
  '../../firebase-applet-config.json',
  { eager: true }
);
const localFirebaseConfig = localConfigModules['../../firebase-applet-config.json']?.default;

const firebaseConfig: FirebaseAppletConfig = {
  ...exampleFirebaseConfig,
  ...(localFirebaseConfig || {}),
  ...(import.meta.env.VITE_FIREBASE_API_KEY
    ? {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || localFirebaseConfig?.authDomain || exampleFirebaseConfig.authDomain,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || localFirebaseConfig?.projectId || exampleFirebaseConfig.projectId,
        storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || localFirebaseConfig?.storageBucket || exampleFirebaseConfig.storageBucket,
        messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || localFirebaseConfig?.messagingSenderId || exampleFirebaseConfig.messagingSenderId,
        appId: import.meta.env.VITE_FIREBASE_APP_ID || localFirebaseConfig?.appId || exampleFirebaseConfig.appId,
        firestoreDatabaseId: import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || localFirebaseConfig?.firestoreDatabaseId || exampleFirebaseConfig.firestoreDatabaseId,
      }
    : {}),
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export { onAuthStateChanged };
export type { User };

function sanitizeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `id_${Date.now()}`;
}

export async function fetchFamilyProfile(userId: string): Promise<FamilyProfile | null> {
  const path = `users/${userId}/profile/family`;
  try {
    const snap = await getDoc(doc(db, 'users', userId, 'profile', 'family'));
    if (!snap.exists()) return null;
    return snap.data() as FamilyProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveFamilyProfile(userId: string, profile: FamilyProfile): Promise<void> {
  const path = `users/${userId}/profile/family`;
  const ref = doc(db, 'users', userId, 'profile', 'family');
  try {
    const existingSnap = await getDoc(ref);
    const sanitized = {
      ownerId: userId,
      householdName: (profile.householdName || 'My Household').trim().slice(0, 80) || 'My Household',
      locationLabel: (profile.locationLabel || 'San Francisco, CA').trim().slice(0, 200) || 'San Francisco, CA',
      lat: Math.max(-90, Math.min(90, Number(profile.lat) || 37.7599)),
      lng: Math.max(-180, Math.min(180, Number(profile.lng) || -122.4148)),
      vulnerabilities: Array.isArray(profile.vulnerabilities) ? profile.vulnerabilities.slice(0, 8) : [],
      commuteType: profile.commuteType,
      vehicleEmissionType: profile.vehicleEmissionType,
      cookingSetup: profile.cookingSetup,
      rangeHood: profile.rangeHood,
      airPurifier: profile.airPurifier,
      windowVentilation: profile.windowVentilation,
    };

    if (existingSnap.exists()) {
      await updateDoc(ref, {
        ...sanitized,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ...sanitized,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToRoomScans(
  userId: string,
  onData: (scans: RoomScanResult[]) => void,
  onError?: (err: Error) => void
): () => void {
  const path = `users/${userId}/roomScans`;
  const q = query(
    collection(db, 'users', userId, 'roomScans'),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(12)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<RoomScanResult, 'id'>),
      }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

export async function saveRoomScan(
  userId: string,
  scan: Omit<RoomScanResult, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const scanId = sanitizeDocId(`scan_${Date.now()}`);
  const path = `users/${userId}/roomScans/${scanId}`;
  try {
    await setDoc(doc(db, 'users', userId, 'roomScans', scanId), {
      ownerId: userId,
      roomType: scan.roomType,
      overallRiskLevel: scan.overallRiskLevel,
      roomSummary: (scan.roomSummary || 'Room scanned.').slice(0, 580),
      outdoorAqiAtScan: Math.max(0, Math.min(500, Number(scan.outdoorAqiAtScan) || 0)),
      ventilationAdvice: (scan.ventilationAdvice || 'Ventilate during low-AQI window.').slice(0, 580),
      detectedRisks: (scan.detectedRisks || []).slice(0, 6),
      hacks: (scan.hacks || []).slice(0, 3),
      completedHackIds: (scan.completedHackIds || []).slice(0, 3),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return scanId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function toggleRoomScanHack(
  userId: string,
  scanId: string,
  completedHackIds: string[]
): Promise<void> {
  const path = `users/${userId}/roomScans/${scanId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'roomScans', scanId), {
      completedHackIds: completedHackIds.slice(0, 3),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteRoomScan(userId: string, scanId: string): Promise<void> {
  const path = `users/${userId}/roomScans/${scanId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'roomScans', scanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToRoutinePlans(
  userId: string,
  onData: (plans: RoutinePlan[]) => void,
  onError?: (err: Error) => void
): () => void {
  const path = `users/${userId}/routinePlans`;
  const q = query(
    collection(db, 'users', userId, 'routinePlans'),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(8)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<RoutinePlan, 'id'>),
      }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

export async function saveRoutinePlan(
  userId: string,
  plan: Omit<RoutinePlan, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const planId = sanitizeDocId(`plan_${Date.now()}`);
  const path = `users/${userId}/routinePlans/${planId}`;
  try {
    // Strip large encoded polylines before saving to Firestore so documents stay lightweight
    const compactSwaps = (plan.swaps || []).slice(0, 10).map((s) => ({
      ...s,
      baselinePolyline: (s.baselinePolyline || '').slice(0, 2000),
      recommendedPolyline: (s.recommendedPolyline || '').slice(0, 2000),
    }));
    await setDoc(doc(db, 'users', userId, 'routinePlans', planId), {
      ownerId: userId,
      planTitle: (plan.planTitle || 'Clean-Air Daily Routine').slice(0, 118),
      locationLabel: (plan.locationLabel || 'Home').slice(0, 198),
      swaps: compactSwaps,
      acceptedSwapIds: (plan.acceptedSwapIds || []).slice(0, 10),
      personalPm25ReductionPct: Math.max(0, Math.min(100, Number(plan.personalPm25ReductionPct) || 0)),
      personalPm25UgSaved: Math.max(0, Math.min(50000, Number(plan.personalPm25UgSaved) || 0)),
      communityCo2GramsSaved: Math.max(0, Math.min(500000, Number(plan.communityCo2GramsSaved) || 0)),
      communityNoxMgSaved: Math.max(0, Math.min(500000, Number(plan.communityNoxMgSaved) || 0)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return planId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateRoutinePlanAcceptance(
  userId: string,
  planId: string,
  updates: {
    acceptedSwapIds: string[];
    personalPm25ReductionPct: number;
    personalPm25UgSaved: number;
    communityCo2GramsSaved: number;
    communityNoxMgSaved: number;
  }
): Promise<void> {
  const path = `users/${userId}/routinePlans/${planId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'routinePlans', planId), {
      acceptedSwapIds: updates.acceptedSwapIds.slice(0, 10),
      personalPm25ReductionPct: Math.max(0, Math.min(100, updates.personalPm25ReductionPct)),
      personalPm25UgSaved: Math.max(0, Math.min(50000, updates.personalPm25UgSaved)),
      communityCo2GramsSaved: Math.max(0, Math.min(500000, updates.communityCo2GramsSaved)),
      communityNoxMgSaved: Math.max(0, Math.min(500000, updates.communityNoxMgSaved)),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function formatFirestoreDate(ts: unknown): string {
  if (!ts) return 'Just now';
  if (ts instanceof Timestamp) {
    return ts.toDate().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return 'Saved';
}
