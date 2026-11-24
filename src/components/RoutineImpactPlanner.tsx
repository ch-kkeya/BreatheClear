import React, { useEffect, useMemo, useState } from 'react';
import {
  Map as GoogleMap,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Route as RouteIcon,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  Circle,
  ExternalLink,
  Leaf,
  Wind,
  Car,
  TrainFront,
  Bike,
  Footprints,
  MapPin,
} from 'lucide-react';
import type {
  AirQualityOverview,
  FamilyProfile,
  RoutinePlan,
  RoutineSwapItem,
  ScheduleItemInput,
} from '../types';
import { apiFetchJson, decodePolyline } from '../lib/aqiUtils';
import { formatFirestoreDate } from '../lib/firebase';

const MODE_LABELS: Record<'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK', string> = {
  DRIVE: 'Drive',
  TRANSIT: 'Transit',
  BICYCLE: 'Bike',
  WALK: 'Walk',
};

function ModeIcon({ mode, className = 'w-4 h-4' }: { mode: string; className?: string }) {
  if (mode === 'TRANSIT') return <TrainFront className={className} />;
  if (mode === 'BICYCLE') return <Bike className={className} />;
  if (mode === 'WALK') return <Footprints className={className} />;
  return <Car className={className} />;
}

/**
 * Renders the baseline route polyline (dashed slate) and recommended low-emission route polyline (teal)
 * directly on the Google Map instance and fits bounds cleanly.
 */
const RoutePolylineLayer: React.FC<{
  home: { lat: number; lng: number };
  swap: RoutineSwapItem | null;
}> = ({ home, swap }) => {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const coreLib = useMapsLibrary('core');

  useEffect(() => {
    if (!map || !mapsLib || !coreLib || !swap) return;

    const baselinePath = decodePolyline(swap.baselinePolyline);
    const recPath = decodePolyline(swap.recommendedPolyline);

    const polylines: google.maps.Polyline[] = [];

    if (baselinePath.length > 1) {
      polylines.push(
        new mapsLib.Polyline({
          map,
          path: baselinePath,
          strokeColor: '#64748B',
          strokeOpacity: 0.55,
          strokeWeight: 4,
          zIndex: 1,
        })
      );
    }

    if (recPath.length > 1) {
      polylines.push(
        new mapsLib.Polyline({
          map,
          path: recPath,
          strokeColor: '#0E6B5E',
          strokeOpacity: 0.95,
          strokeWeight: 5,
          zIndex: 2,
        })
      );
    }

    const bounds = new coreLib.LatLngBounds();
    bounds.extend(home);
    bounds.extend({ lat: swap.destinationLat, lng: swap.destinationLng });
    if (swap.nearbyCleanStop) {
      bounds.extend({ lat: swap.nearbyCleanStop.lat, lng: swap.nearbyCleanStop.lng });
    }
    for (const pt of recPath.slice(0, 60)) {
      bounds.extend(pt);
    }
    map.fitBounds(bounds, 48);

    return () => {
      polylines.forEach((p) => p.setMap(null));
    };
  }, [map, mapsLib, coreLib, home, swap]);

  return null;
};

interface RoutineImpactPlannerProps {
  profile: FamilyProfile;
  overview: AirQualityOverview | null;
  savedPlans: RoutinePlan[];
  isSignedIn: boolean;
  onSavePlan: (plan: Omit<RoutinePlan, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => Promise<string | null>;
  onUpdateAcceptance: (
    planId: string,
    updates: {
      acceptedSwapIds: string[];
      personalPm25ReductionPct: number;
      personalPm25UgSaved: number;
      communityCo2GramsSaved: number;
      communityNoxMgSaved: number;
    }
  ) => Promise<void>;
  onSignInPrompt: () => void;
}

export const RoutineImpactPlanner: React.FC<RoutineImpactPlannerProps> = ({
  profile,
  overview,
  savedPlans,
  isSignedIn,
  onSavePlan,
  onUpdateAcceptance,
  onSignInPrompt,
}) => {
  const defaultMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK' =
    profile.commuteType === 'HYBRID' ? 'DRIVE' : profile.commuteType;

  const [schedule, setSchedule] = useState<ScheduleItemInput[]>([
    {
      id: 'stop-1',
      time: '08:15 AM',
      title: 'Morning Commute',
      destinationQuery: 'Downtown Civic Center',
      currentMode: defaultMode,
    },
    {
      id: 'stop-2',
      time: '12:45 PM',
      title: 'Grocery & Midday Errand',
      destinationQuery: 'Neighborhood Grocery Market',
      currentMode: 'DRIVE',
    },
    {
      id: 'stop-3',
      time: '05:30 PM',
      title: 'Evening Park & Family Walk',
      destinationQuery: 'Nearest Public Park',
      currentMode: 'DRIVE',
    },
  ]);

  const [isPlanning, setIsPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<RoutinePlan | null>(null);
  const [selectedSwapId, setSelectedSwapId] = useState<string | null>(null);

  // Sync latest saved plan from Firestore if none is active yet
  useEffect(() => {
    if (!activePlan && savedPlans.length > 0) {
      setActivePlan(savedPlans[0]);
      setSelectedSwapId(savedPlans[0].swaps?.[0]?.id || null);
    }
  }, [savedPlans, activePlan]);

  const handleAddStop = () => {
    if (schedule.length >= 6) return;
    setSchedule((prev) => [
      ...prev,
      {
        id: `stop-${Date.now()}`,
        time: '03:00 PM',
        title: 'Afternoon Trip',
        destinationQuery: 'Public Library',
        currentMode: 'DRIVE',
      },
    ]);
  };

  const handleUpdateStop = (id: string, patch: Partial<ScheduleItemInput>) => {
    setSchedule((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const handleRemoveStop = (id: string) => {
    setSchedule((prev) => prev.filter((item) => item.id !== id));
  };

  const handleGeneratePlan = async () => {
    const cleanSchedule = schedule.filter((s) => s.destinationQuery.trim().length > 0);
    if (cleanSchedule.length === 0) {
      setError('Enter at least one destination to build your clean-air routine.');
      return;
    }

    try {
      setIsPlanning(true);
      setError(null);

      const response = await apiFetchJson<Omit<RoutinePlan, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>>(
        '/api/routine/plan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            homeLocation: {
              label: profile.locationLabel,
              lat: profile.lat,
              lng: profile.lng,
            },
            schedule: cleanSchedule,
            familyProfile: profile,
            currentAqi: overview?.usAqi ?? 45,
            hourlyForecast: overview?.timeline ?? [],
          }),
        }
      );

      let savedId: string | null = null;
      if (isSignedIn) {
        savedId = await onSavePlan(response);
      }

      const plan: RoutinePlan = {
        ...response,
        id: savedId || `local-plan-${Date.now()}`,
        ownerId: profile.ownerId,
      };
      setActivePlan(plan);
      setSelectedSwapId(plan.swaps[0]?.id || null);
    } catch (err: any) {
      setError(err?.message || 'Unable to compute route swaps right now.');
    } finally {
      setIsPlanning(false);
    }
  };

  const impactTotals = useMemo(() => {
    if (!activePlan) {
      return {
        acceptedCount: 0,
        totalCount: 0,
        pm25UgSaved: 0,
        pm25ReductionPct: 0,
        co2GramsSaved: 0,
        noxMgSaved: 0,
      };
    }
    const acceptedSet = new Set(activePlan.acceptedSwapIds);
    const adopted = activePlan.swaps.filter((s) => acceptedSet.has(s.id));
    const pm25UgSaved = Math.round(adopted.reduce((sum, s) => sum + s.personalPm25UgSaved, 0) * 10) / 10;
    const pm25ReductionPct =
      adopted.length > 0
        ? Math.round(adopted.reduce((sum, s) => sum + s.personalPm25ReductionPct, 0) / adopted.length)
        : 0;
    const co2GramsSaved = adopted.reduce((sum, s) => sum + s.communityCo2GramsSaved, 0);
    const noxMgSaved = adopted.reduce((sum, s) => sum + s.communityNoxMgSaved, 0);

    return {
      acceptedCount: adopted.length,
      totalCount: activePlan.swaps.length,
      pm25UgSaved,
      pm25ReductionPct,
      co2GramsSaved,
      noxMgSaved,
    };
  }, [activePlan]);

  const handleToggleAcceptSwap = async (swapId: string) => {
    if (!activePlan) return;
    const exists = activePlan.acceptedSwapIds.includes(swapId);
    const nextIds = exists
      ? activePlan.acceptedSwapIds.filter((id) => id !== swapId)
      : [...activePlan.acceptedSwapIds, swapId];

    const adopted = activePlan.swaps.filter((s) => nextIds.includes(s.id));
    const pm25UgSaved = Math.round(adopted.reduce((sum, s) => sum + s.personalPm25UgSaved, 0) * 10) / 10;
    const pm25ReductionPct =
      adopted.length > 0
        ? Math.round(adopted.reduce((sum, s) => sum + s.personalPm25ReductionPct, 0) / adopted.length)
        : 0;
    const co2GramsSaved = adopted.reduce((sum, s) => sum + s.communityCo2GramsSaved, 0);
    const noxMgSaved = adopted.reduce((sum, s) => sum + s.communityNoxMgSaved, 0);

    const updatedPlan: RoutinePlan = {
      ...activePlan,
      acceptedSwapIds: nextIds,
      personalPm25ReductionPct: pm25ReductionPct,
      personalPm25UgSaved: pm25UgSaved,
      communityCo2GramsSaved: co2GramsSaved,
      communityNoxMgSaved: noxMgSaved,
    };
    setActivePlan(updatedPlan);

    if (isSignedIn && activePlan.id && !activePlan.id.startsWith('local-')) {
      await onUpdateAcceptance(activePlan.id, {
        acceptedSwapIds: nextIds,
        personalPm25ReductionPct: pm25ReductionPct,
        personalPm25UgSaved: pm25UgSaved,
        communityCo2GramsSaved: co2GramsSaved,
        communityNoxMgSaved: noxMgSaved,
      });
    }
  };

  const selectedSwap =
    activePlan?.swaps.find((s) => s.id === selectedSwapId) || activePlan?.swaps[0] || null;

  return (
    <div className="space-y-6">
      {/* Direct Impact Card (Prominent Quantified Personal + Community Dual-Metric Hero) */}
      {activePlan && (
        <section className="bg-[#0F2420] text-white rounded-2xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-emerald-300/90">
                Direct Impact Card · {impactTotals.acceptedCount} of {impactTotals.totalCount} swaps active
              </p>
              <h2 className="mt-1 text-xl sm:text-2xl font-bold tracking-tight text-white">
                {activePlan.planTitle}
              </h2>
            </div>
            {!isSignedIn && (
              <button
                type="button"
                onClick={onSignInPrompt}
                className="text-xs font-semibold text-emerald-200 hover:text-white underline cursor-pointer"
              >
                Sign in to save plan
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Personal Inhaled-Pollution Reduction */}
            <div className="rounded-xl bg-white/8 border border-white/12 p-4 sm:p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
                <Wind className="w-4 h-4" />
                <span>Personal Inhaled-Pollution Reduction</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono tabular-nums text-3xl sm:text-4xl font-bold text-white">
                  -{impactTotals.pm25ReductionPct}%
                </span>
                <span className="font-mono tabular-nums text-sm text-emerald-200">
                  -{impactTotals.pm25UgSaved.toFixed(1)} µg PM2.5 / day
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                ~{((impactTotals.pm25UgSaved * 250) / 1000).toFixed(1)} mg/year less fine
                particulate lung exposure across weekday routines.
              </p>
            </div>

            {/* Community Emissions Avoided */}
            <div className="rounded-xl bg-white/8 border border-white/12 p-4 sm:p-5 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
                <Leaf className="w-4 h-4" />
                <span>Community Emissions Avoided</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="font-mono tabular-nums text-3xl sm:text-4xl font-bold text-white">
                  -{(impactTotals.co2GramsSaved / 1000).toFixed(2)} kg
                </span>
                <span className="font-mono tabular-nums text-sm text-emerald-200">
                  CO₂e / day · -{(impactTotals.noxMgSaved / 1000).toFixed(2)} g NOₓ
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                ~{Math.round((impactTotals.co2GramsSaved * 250) / 1000)} kg CO₂e/year kept out of
                neighborhood street air based on Google Routes distances.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Main 2-Column Workspace: Schedule Input (Left) + Swaps & Live Route Comparison Map (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Daily Schedule Editor */}
        <section className="lg:col-span-5 bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-[#0F1D1A]">Your Daily Routine</h3>
              <p className="text-xs text-[#4B5E59] mt-0.5">
                Anchored to {profile.locationLabel}
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddStop}
              disabled={schedule.length >= 6}
              className="inline-flex items-center gap-1 min-h-[36px] px-3 py-1.5 rounded-lg bg-[#F6F8F7] border border-slate-200 text-xs font-semibold text-[#0F1D1A] hover:bg-slate-100 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5 text-[#0E6B5E]" />
              Add Stop
            </button>
          </div>

          <div className="space-y-3">
            {schedule.map((item, idx) => (
              <div
                key={item.id}
                className="rounded-xl bg-[#F6F8F7] border border-slate-200/80 p-3.5 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#0E6B5E]">
                    0{idx + 1}. Routine Leg
                  </span>
                  {schedule.length > 1 && (
                    <button
                      type="button"
                      aria-label="Remove stop"
                      onClick={() => handleRemoveStop(item.id)}
                      className="min-w-[32px] min-h-[32px] flex items-center justify-center text-slate-400 hover:text-red-700 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-5 gap-2">
                  <input
                    type="text"
                    value={item.time}
                    onChange={(e) => handleUpdateStop(item.id, { time: e.target.value })}
                    placeholder="08:30 AM"
                    aria-label="Departure time"
                    className="col-span-2 min-h-[40px] px-2.5 rounded-lg bg-white border border-slate-200 text-xs font-mono text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                  />
                  <input
                    type="text"
                    value={item.title}
                    onChange={(e) => handleUpdateStop(item.id, { title: e.target.value })}
                    placeholder="Activity label"
                    aria-label="Activity label"
                    className="col-span-3 min-h-[40px] px-2.5 rounded-lg bg-white border border-slate-200 text-xs text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                  />
                </div>

                <input
                  type="text"
                  value={item.destinationQuery}
                  onChange={(e) => handleUpdateStop(item.id, { destinationQuery: e.target.value })}
                  placeholder="Destination place (e.g., Ferry Building, Whole Foods, City Hall)"
                  aria-label="Destination"
                  className="w-full min-h-[40px] px-3 rounded-lg bg-white border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                />

                <div className="grid grid-cols-4 gap-1">
                  {(['DRIVE', 'TRANSIT', 'BICYCLE', 'WALK'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleUpdateStop(item.id, { currentMode: mode })}
                      className={`min-h-[36px] rounded-lg text-[11px] font-medium flex items-center justify-center gap-1 transition-colors cursor-pointer ${
                        item.currentMode === mode
                          ? 'bg-[#0F1D1A] text-white'
                          : 'bg-white text-[#4B5E59] border border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <ModeIcon mode={mode} className="w-3.5 h-3.5" />
                      <span>{MODE_LABELS[mode]}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-800">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleGeneratePlan()}
            disabled={isPlanning}
            className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-[#0E6B5E] text-white text-sm font-semibold hover:bg-[#0A5248] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isPlanning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Computing Google Routes &amp; Clean Swaps...
              </>
            ) : (
              <>
                <RouteIcon className="w-4 h-4" />
                Generate Low-Emission Swaps
              </>
            )}
          </button>

          {/* Saved Plans History */}
          {isSignedIn && savedPlans.length > 0 && (
            <div className="pt-4 border-t border-slate-100 space-y-2">
              <p className="text-xs font-bold text-[#0F1D1A]">Recent Saved Plans</p>
              <div className="divide-y divide-slate-100">
                {savedPlans.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setActivePlan(p);
                      setSelectedSwapId(p.swaps[0]?.id || null);
                    }}
                    className="w-full text-left py-2.5 flex items-center justify-between gap-2 hover:bg-[#F6F8F7] rounded-lg px-2 transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[#0F1D1A] truncate">{p.planTitle}</p>
                      <p className="text-[11px] text-[#4B5E59]">{formatFirestoreDate(p.createdAt)}</p>
                    </div>
                    <span className="font-mono tabular-nums text-xs font-semibold text-[#0E6B5E] shrink-0">
                      -{(p.communityCo2GramsSaved / 1000).toFixed(1)} kg CO₂
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right: Route Comparison Map + Swap Cards */}
        <section className="lg:col-span-7 space-y-5">
          {activePlan && activePlan.swaps.length > 0 ? (
            <>
              {/* Interactive Route Swap Map */}
              <div className="bg-white rounded-2xl border border-slate-200/90 overflow-hidden">
                <div className="px-4 sm:px-5 py-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-[#0F1D1A]">
                      Route Comparison · {selectedSwap?.title || 'Selected Leg'}
                    </h3>
                    <p className="text-xs text-[#4B5E59]">
                      Teal line: Recommended clean swap · Slate line: Baseline route
                    </p>
                  </div>
                  {selectedSwap && (
                    <span className="font-mono tabular-nums text-xs font-semibold text-[#0E6B5E]">
                      {selectedSwap.distanceKm} km · {selectedSwap.recommendedDurationMin} min
                    </span>
                  )}
                </div>

                <div className="w-full h-[270px] sm:h-[310px]">
                  <GoogleMap
                    mapId="DEMO_MAP_ID"
                    defaultCenter={{ lat: profile.lat, lng: profile.lng }}
                    defaultZoom={13}
                    gestureHandling="greedy"
                    streetViewControl={false}
                    mapTypeControl={false}
                    internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                    style={{ width: '100%', height: '100%' }}
                  >
                    <RoutePolylineLayer
                      home={{ lat: profile.lat, lng: profile.lng }}
                      swap={selectedSwap}
                    />
                    <AdvancedMarker position={{ lat: profile.lat, lng: profile.lng }}>
                      <div className="px-2.5 py-1 rounded-lg bg-[#0F1D1A] text-white text-[11px] font-semibold shadow">
                        Home
                      </div>
                    </AdvancedMarker>
                    {selectedSwap && (
                      <AdvancedMarker
                        position={{
                          lat: selectedSwap.destinationLat,
                          lng: selectedSwap.destinationLng,
                        }}
                      >
                        <div className="px-2.5 py-1 rounded-lg bg-[#0E6B5E] text-white text-[11px] font-semibold shadow max-w-[160px] truncate">
                          {selectedSwap.destinationName}
                        </div>
                      </AdvancedMarker>
                    )}
                    {selectedSwap?.nearbyCleanStop && (
                      <AdvancedMarker
                        position={{
                          lat: selectedSwap.nearbyCleanStop.lat,
                          lng: selectedSwap.nearbyCleanStop.lng,
                        }}
                      >
                        <div className="px-2 py-1 rounded-lg bg-white border border-[#0E6B5E] text-[#0E6B5E] text-[10px] font-semibold shadow max-w-[140px] truncate">
                          {selectedSwap.nearbyCleanStop.name}
                        </div>
                      </AdvancedMarker>
                    )}
                  </GoogleMap>
                </div>
              </div>

              {/* Actionable Swap Cards */}
              <div className="space-y-3">
                {activePlan.swaps.map((swap) => {
                  const accepted = activePlan.acceptedSwapIds.includes(swap.id);
                  const isFocused = selectedSwap?.id === swap.id;
                  return (
                    <div
                      key={swap.id}
                      className={`bg-white rounded-2xl border p-4 sm:p-5 transition-colors space-y-3 ${
                        isFocused ? 'border-[#0E6B5E]' : 'border-slate-200/90'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedSwapId(swap.id)}
                          className="text-left flex-1 min-w-0 cursor-pointer space-y-1"
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#4B5E59]">
                            <span className="font-mono font-semibold text-[#0F1D1A]">
                              {swap.time}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{swap.title}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-[#0E6B5E]">
                              {MODE_LABELS[swap.currentMode]} → {MODE_LABELS[swap.recommendedMode]}
                            </span>
                          </div>
                          <h4 className="text-base font-bold text-[#0F1D1A]">
                            {swap.swapHeadline}
                          </h4>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleToggleAcceptSwap(swap.id)}
                          className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer whitespace-nowrap ${
                            accepted
                              ? 'bg-[#0E6B5E] text-white'
                              : 'bg-[#F6F8F7] text-[#2F413D] border border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {accepted ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <Circle className="w-4 h-4" />
                          )}
                          {accepted ? 'Adopted' : 'Adopt Swap'}
                        </button>
                      </div>

                      <p className="text-sm text-[#2F413D] leading-relaxed">{swap.swapRationale}</p>

                      {/* Verified Places & Routes Telemetry Row */}
                      <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-[#4B5E59]">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-mono tabular-nums text-[#0F1D1A] font-semibold">
                            -{swap.personalPm25ReductionPct}% inhaled PM2.5
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-[#0E6B5E] font-semibold">
                            -{(swap.communityCo2GramsSaved / 1000).toFixed(2)} kg CO₂e
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {swap.currentDurationMin}m → {swap.recommendedDurationMin}m
                          </span>
                        </div>
                        <span className="text-[#0E6B5E] font-medium">
                          {swap.recommendedTimeWindow}
                        </span>
                      </div>

                      {/* Real Google Places Links */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                        <span className="inline-flex items-center gap-1 text-[#4B5E59]">
                          <MapPin className="w-3.5 h-3.5 text-[#0E6B5E]" />
                          {swap.destinationName}
                          {swap.destinationMapsUri && (
                            <a
                              href={swap.destinationMapsUri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 text-[#0E6B5E] hover:underline ml-1"
                            >
                              Maps <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </span>

                        {swap.nearbyCleanStop && (
                          <span className="inline-flex items-center gap-1 text-[#4B5E59]">
                            Nearby clean stop: <strong className="text-[#0F1D1A]">{swap.nearbyCleanStop.name}</strong>
                            {swap.nearbyCleanStop.googleMapsUri && (
                              <a
                                href={swap.nearbyCleanStop.googleMapsUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[#0E6B5E] hover:underline ml-0.5"
                              >
                                View <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[#F6F8F7] text-[#0E6B5E] flex items-center justify-center mx-auto">
                <RouteIcon className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-[#0F1D1A]">
                Turn your daily schedule into cleaner air
              </h3>
              <p className="text-sm text-[#4B5E59] max-w-md mx-auto leading-relaxed">
                Customize your daily trips on the left and click{' '}
                <strong className="text-[#0F1D1A]">Generate Low-Emission Swaps</strong> to compare
                real Google Maps routes, find nearby transit/green stops, and quantify your Direct
                Impact Card.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
