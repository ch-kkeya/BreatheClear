import React, { useCallback, useEffect, useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import {
  MapPin,
  Camera,
  Route as RouteIcon,
  Users,
  LogIn,
  LogOut,
  Loader2,
} from 'lucide-react';
import {
  auth,
  deleteRoomScan,
  fetchFamilyProfile,
  onAuthStateChanged,
  saveFamilyProfile,
  saveRoomScan,
  saveRoutinePlan,
  signInWithGoogle,
  signOutUser,
  subscribeToRoomScans,
  subscribeToRoutinePlans,
  toggleRoomScanHack,
  updateRoutinePlanAcceptance,
  type User,
} from './lib/firebase';
import { apiFetchJson } from './lib/aqiUtils';
import { getErrorMessage } from './lib/airQualityDomain';
import {
  DEFAULT_FAMILY_PROFILE,
  type AirQualityOverview,
  type FamilyProfile,
  type RoomScanResult,
  type RoutinePlan,
} from './types';
import { HyperLocalAirMap } from './components/HyperLocalAirMap';
import { RoomIaqScanner } from './components/RoomIaqScanner';
import { RoutineImpactPlanner } from './components/RoutineImpactPlanner';
import { FamilyProfileForm } from './components/FamilyProfileForm';

type AppTab = 'map' | 'scan' | 'planner' | 'family';

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('map');
  const [mapsApiKey, setMapsApiKey] = useState<string>(
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''
  );
  const [configLoaded, setConfigLoaded] = useState<boolean>(
    Boolean(import.meta.env.VITE_GOOGLE_MAPS_API_KEY)
  );
  const [quotaExceeded, setQuotaExceeded] = useState<boolean>(false);

  // Firebase Auth & Firestore State
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<FamilyProfile>(DEFAULT_FAMILY_PROFILE);
  const [savedScans, setSavedScans] = useState<RoomScanResult[]>([]);
  const [savedPlans, setSavedPlans] = useState<RoutinePlan[]>([]);

  // Live Air Quality & Location State
  const [inspectedCoords, setInspectedCoords] = useState({
    lat: DEFAULT_FAMILY_PROFILE.lat,
    lng: DEFAULT_FAMILY_PROFILE.lng,
    label: DEFAULT_FAMILY_PROFILE.locationLabel,
  });
  const [overview, setOverview] = useState<AirQualityOverview | null>(null);
  const [aqLoading, setAqLoading] = useState<boolean>(false);
  const [aqError, setAqError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState<boolean>(false);

  // Listen to Demo Key Quota Exceeded events globally so banner persists across views
  useEffect(() => {
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  // Load Maps API key from server config if not already injected via VITE_GOOGLE_MAPS_API_KEY
  useEffect(() => {
    if (mapsApiKey) {
      setConfigLoaded(true);
      return;
    }
    let cancelled = false;
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.mapsApiKey) {
          setMapsApiKey(data.mapsApiKey);
        }
      })
      .catch((err) => console.error('Config fetch failed:', err))
      .finally(() => {
        if (!cancelled) setConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapsApiKey]);

  // Firebase Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);

      if (nextUser) {
        try {
          const remoteProfile = await fetchFamilyProfile(nextUser.uid);
          if (remoteProfile) {
            setProfile(remoteProfile);
            setInspectedCoords({
              lat: remoteProfile.lat,
              lng: remoteProfile.lng,
              label: remoteProfile.locationLabel,
            });
          } else {
            setProfile((prev) => ({
              ...prev,
              ownerId: nextUser.uid,
              householdName: nextUser.displayName ? `${nextUser.displayName.split(' ')[0]}'s Home` : prev.householdName,
            }));
          }
        } catch (err) {
          console.error('Could not load family profile:', err);
        }
      } else {
        setSavedScans([]);
        setSavedPlans([]);
      }
    });
    return () => unsub();
  }, []);

  // Attach Firestore real-time subscriptions ONLY when auth is ready and user is authenticated
  useEffect(() => {
    if (!authReady || !user) return;

    const unsubScans = subscribeToRoomScans(user.uid, setSavedScans, (err) => {
      console.error('Room scans listener error:', err);
    });
    const unsubPlans = subscribeToRoutinePlans(user.uid, setSavedPlans, (err) => {
      console.error('Routine plans listener error:', err);
    });

    return () => {
      unsubScans();
      unsubPlans();
    };
  }, [authReady, user]);

  // Fetch live Air Quality + Weather overview
  const loadAirQuality = useCallback(
    async (lat: number, lng: number, vulnerabilities: string[]) => {
      try {
        setAqLoading(true);
        setAqError(null);
        const data = await apiFetchJson<AirQualityOverview>('/api/air-quality/overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lng, vulnerabilities }),
        });
        setOverview(data);
      } catch (err: unknown) {
        setAqError(getErrorMessage(err, 'Unable to fetch air quality conditions.'));
      } finally {
        setAqLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadAirQuality(inspectedCoords.lat, inspectedCoords.lng, profile.vulnerabilities);
  }, [inspectedCoords.lat, inspectedCoords.lng, profile.vulnerabilities, loadAirQuality]);

  const handleGoogleSignIn = async () => {
    try {
      setAuthError(null);
      await signInWithGoogle();
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code !== 'auth/popup-closed-by-user') {
        setAuthError(getErrorMessage(err, 'Google Sign-In failed. Please try again.'));
      }
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
  };

  const handleLocateMe = useCallback((): Promise<{ lat: number; lng: number; label: string } | null> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setAqError('Browser geolocation is not supported on this device.');
        resolve(null);
        return;
      }
      setIsLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            label: `Current Location (${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)})`,
          };
          setInspectedCoords(coords);
          setIsLocating(false);
          resolve(coords);
        },
        () => {
          setAqError('Location permission denied. Search any neighborhood above instead.');
          setIsLocating(false);
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 8000 }
      );
    });
  }, []);

  const handleSaveProfile = async (updated: FamilyProfile) => {
    const nextProfile: FamilyProfile = {
      ...updated,
      ownerId: user?.uid || 'local-guest',
    };
    setProfile(nextProfile);
    setInspectedCoords({
      lat: nextProfile.lat,
      lng: nextProfile.lng,
      label: nextProfile.locationLabel,
    });
    if (user) {
      await saveFamilyProfile(user.uid, nextProfile);
    }
  };

  const navItems: Array<{ id: AppTab; label: string; mobileLabel: string; icon: React.ReactNode }> = [
    { id: 'map', label: 'Air Map', mobileLabel: 'Air Map', icon: <MapPin className="w-5 h-5" /> },
    { id: 'scan', label: 'Room Scan', mobileLabel: 'Room Scan', icon: <Camera className="w-5 h-5" /> },
    {
      id: 'planner',
      label: 'Routine Planner',
      mobileLabel: 'Planner',
      icon: <RouteIcon className="w-5 h-5" />,
    },
    {
      id: 'family',
      label: 'Family Profile',
      mobileLabel: 'Family',
      icon: <Users className="w-5 h-5" />,
    },
  ];

  const appContent = (
    <div className="min-h-screen flex flex-col bg-[#F6F8F7] text-[#0F1D1A]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:rounded-xl focus:bg-[#0E6B5E] focus:text-white focus:text-xs focus:font-semibold"
      >
        Skip to main content
      </a>

      {/* Non-intrusive Demo Key Quota Banner (Tier 1 & Tier 2) */}
      {quotaExceeded && (
        <div
          role="status"
          aria-live="polite"
          className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm"
        >
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Navigation Bar (Strict 3-Zone Desktop Contract / Compact 52px Mobile Header) */}
      <header className="sticky top-0 z-30 h-[52px] md:h-16 bg-white/90 backdrop-blur-md border-b border-slate-200/80">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
          {/* Zone 1: Single-element Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('map')}
            aria-label="BreatheClear Home - Air Map"
            className="font-display text-lg font-extrabold tracking-tight text-[#0F1D1A] whitespace-nowrap shrink-0 cursor-pointer"
          >
            BreatheClear
          </button>

          {/* Zone 2: 4 Clean Single-Line Text Nav Links (Desktop) */}
          <nav
            aria-label="Primary desktop navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-[#4B5E59]"
          >
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => setActiveTab(item.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                  activeTab === item.id
                    ? 'text-[#0E6B5E] border-[#0E6B5E] font-semibold'
                    : 'border-transparent hover:text-[#0F1D1A]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 Primary Auth Action */}
          <div className="flex items-center shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => void handleSignOut()}
                aria-label={`Sign out (${user.displayName || user.email || 'user'})`}
                className="inline-flex items-center gap-2 min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#F6F8F7] border border-slate-200 text-xs font-semibold text-[#0F1D1A] hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span className="max-w-[110px] truncate">{user.displayName || user.email}</span>
                <LogOut className="w-3.5 h-3.5 text-[#4B5E59]" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleGoogleSignIn()}
                className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#0E6B5E] text-white text-xs font-semibold hover:bg-[#0A5248] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {authError && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-3">
          <div
            role="alert"
            className="rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 text-xs text-red-800 flex items-center justify-between"
          >
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="font-semibold underline ml-3 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Content Workspace */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 pb-24 md:pb-12 focus:outline-none"
      >
        {activeTab === 'map' && (
          <HyperLocalAirMap
            profile={profile}
            overview={overview}
            isLoading={aqLoading}
            error={aqError}
            inspectedCoords={inspectedCoords}
            onSelectCoords={setInspectedCoords}
            onRefresh={() =>
              void loadAirQuality(inspectedCoords.lat, inspectedCoords.lng, profile.vulnerabilities)
            }
            onLocateMe={() => void handleLocateMe()}
            isLocating={isLocating}
          />
        )}

        {activeTab === 'scan' && (
          <RoomIaqScanner
            profile={profile}
            overview={overview}
            savedScans={savedScans}
            isSignedIn={Boolean(user)}
            onSaveScan={async (scan) => (user ? saveRoomScan(user.uid, scan) : null)}
            onToggleHack={async (scanId, completedIds) => {
              if (user) await toggleRoomScanHack(user.uid, scanId, completedIds);
            }}
            onDeleteScan={async (scanId) => {
              if (user) await deleteRoomScan(user.uid, scanId);
            }}
            onSignInPrompt={() => void handleGoogleSignIn()}
          />
        )}

        {activeTab === 'planner' && (
          <RoutineImpactPlanner
            profile={profile}
            overview={overview}
            savedPlans={savedPlans}
            isSignedIn={Boolean(user)}
            onSavePlan={async (plan) => (user ? saveRoutinePlan(user.uid, plan) : null)}
            onUpdateAcceptance={async (planId, updates) => {
              if (user) await updateRoutinePlanAcceptance(user.uid, planId, updates);
            }}
            onSignInPrompt={() => void handleGoogleSignIn()}
          />
        )}

        {activeTab === 'family' && (
          <FamilyProfileForm
            profile={profile}
            isSignedIn={Boolean(user)}
            userEmail={user?.email}
            onSave={handleSaveProfile}
            onSignIn={() => void handleGoogleSignIn()}
            onLocateMe={handleLocateMe}
          />
        )}
      </main>

      {/* Quiet Desktop Footer */}
      <footer className="hidden md:block border-t border-slate-200/80 bg-white/70">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-[#4B5E59]">
          <span>BreatheClear Urban Air Quality Assistant</span>
          <span>
            Map, Air Quality, Weather, Places &amp; Routes data subject to{' '}
            <a
              href="https://maps.google.com/help/terms_maps/?utm_campaign=gmp_mcp_codeassist_v1_aistudio"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-[#0F1D1A]"
            >
              Google Maps Terms
            </a>
          </span>
        </div>
      </footer>

      {/* Fixed Bottom Mobile Tab Bar (Ergonomic Thumb Zone, Compact 60px) */}
      <nav
        aria-label="Primary mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 pb-safe"
      >
        <div className="grid grid-cols-4 h-[60px] items-center">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setActiveTab(item.id)}
                className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                  active ? 'text-[#0E6B5E] font-semibold' : 'text-[#4B5E59]'
                }`}
              >
                {item.icon}
                <span className="text-[10px] tracking-tight whitespace-nowrap">
                  {item.mobileLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );

  if (!configLoaded) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading BreatheClear configuration"
        className="min-h-screen bg-[#F6F8F7] flex items-center justify-center"
      >
        <Loader2 className="w-6 h-6 text-[#0E6B5E] animate-spin" aria-hidden="true" />
        <span className="sr-only">Loading BreatheClear...</span>
      </div>
    );
  }

  return (
    <APIProvider apiKey={mapsApiKey} language="en" region="US">
      {appContent}
    </APIProvider>
  );
}
