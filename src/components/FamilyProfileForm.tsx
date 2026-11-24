import React, { useEffect, useState } from 'react';
import {
  Check,
  LocateFixed,
  Save,
  ShieldCheck,
  Home,
  Car,
  Flame,
  Loader2,
} from 'lucide-react';
import type {
  AirPurifierType,
  CommuteType,
  CookingSetup,
  FamilyProfile,
  RangeHoodType,
  VehicleEmissionType,
  VulnerabilityId,
  WindowVentilationType,
} from '../types';
import { VULNERABILITY_LABELS } from '../lib/aqiUtils';
import { getErrorMessage } from '../lib/airQualityDomain';
import { PlaceSearchInput } from './PlaceSearchInput';

interface FamilyProfileFormProps {
  profile: FamilyProfile;
  isSignedIn: boolean;
  userEmail?: string | null;
  onSave: (updated: FamilyProfile) => Promise<void>;
  onSignIn: () => void;
  onLocateMe: () => Promise<{ lat: number; lng: number; label: string } | null>;
}

const VULNERABILITIES: VulnerabilityId[] = [
  'ASTHMA_COPD',
  'YOUNG_CHILDREN',
  'SENIORS_65',
  'PREGNANCY',
  'CARDIOVASCULAR',
  'OUTDOOR_ATHLETE',
];

export const FamilyProfileForm: React.FC<FamilyProfileFormProps> = ({
  profile,
  isSignedIn,
  userEmail,
  onSave,
  onSignIn,
  onLocateMe,
}) => {
  const [draft, setDraft] = useState<FamilyProfile>(profile);
  const [isSaving, setIsSaving] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const toggleVulnerability = (id: VulnerabilityId) => {
    setDraft((prev) => {
      const exists = prev.vulnerabilities.includes(id);
      return {
        ...prev,
        vulnerabilities: exists
          ? prev.vulnerabilities.filter((v) => v !== id)
          : [...prev.vulnerabilities, id],
      };
    });
  };

  const handleUseCurrentLocation = async () => {
    try {
      setIsLocating(true);
      const loc = await onLocateMe();
      if (loc) {
        setDraft((prev) => ({
          ...prev,
          locationLabel: loc.label,
          lat: loc.lat,
          lng: loc.lng,
        }));
      }
    } finally {
      setIsLocating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSaving(true);
      setSaveError(null);
      setSaveMessage(null);
      await onSave(draft);
      setSaveMessage(
        isSignedIn
          ? 'Family Profile synced to Firebase Firestore. Air Map, Room Scanner, and Routine Planner updated.'
          : 'Family Profile applied for this session. Sign in with Google to save permanently across devices.'
      );
    } catch (err: unknown) {
      setSaveError(getErrorMessage(err, 'Could not save Family Profile.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header / Cloud Sync Banner */}
      <section className="bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#0F1D1A]">Family Air Quality Profile</h2>
          <p className="mt-1 text-sm text-[#4B5E59] leading-relaxed max-w-2xl">
            Personalizes your Safe Ventilation Window thresholds, Gemini room hazard checks, and
            low-emission daily commute calculations.
          </p>
        </div>
        {isSignedIn ? (
          <div className="text-xs text-[#0E6B5E] font-medium shrink-0 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            <span>Synced as {userEmail || 'Signed-in account'}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0F1D1A] text-white text-xs font-semibold hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            Sign in with Google to Sync
          </button>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Column 1: Home Location & Household Vulnerabilities */}
        <section className="lg:col-span-6 bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-6">
          <div className="flex items-center gap-2 text-sm font-bold text-[#0F1D1A]">
            <Home className="w-4 h-4 text-[#0E6B5E]" />
            <span>01. Home Location &amp; Sensitivities</span>
          </div>

          <div className="space-y-2">
            <label htmlFor="householdName" className="block text-xs font-semibold text-[#4B5E59]">
              Household Name
            </label>
            <input
              id="householdName"
              type="text"
              maxLength={80}
              required
              value={draft.householdName}
              onChange={(e) => setDraft({ ...draft, householdName: e.target.value })}
              placeholder="e.g., Rivera Family Home"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:ring-2 focus:ring-[#0E6B5E]/25 focus:border-[#0E6B5E]"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="homeLocation" className="block text-xs font-semibold text-[#4B5E59]">
                Home Street or Neighborhood
              </label>
              <button
                type="button"
                onClick={() => void handleUseCurrentLocation()}
                disabled={isLocating}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#0E6B5E] hover:underline cursor-pointer"
              >
                <LocateFixed className={`w-3.5 h-3.5 ${isLocating ? 'animate-spin' : ''}`} />
                Use current location
              </button>
            </div>
            <PlaceSearchInput
              id="homeLocation"
              value={draft.locationLabel}
              biasLat={draft.lat}
              biasLng={draft.lng}
              onSelect={(place) =>
                setDraft((prev) => ({
                  ...prev,
                  locationLabel: place.label,
                  lat: place.lat,
                  lng: place.lng,
                }))
              }
            />
            <p className="text-[11px] font-mono tabular-nums text-[#6B7E79]">
              Coordinates: {draft.lat.toFixed(4)}, {draft.lng.toFixed(4)}
            </p>
          </div>

          <div className="space-y-2.5" role="group" aria-labelledby="vulnerabilities-group-label">
            <span id="vulnerabilities-group-label" className="block text-xs font-semibold text-[#4B5E59]">
              Household Respiratory Vulnerabilities
            </span>
            <div className="grid grid-cols-2 gap-2">
              {VULNERABILITIES.map((vId) => {
                const active = draft.vulnerabilities.includes(vId);
                return (
                  <button
                    key={vId}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleVulnerability(vId)}
                    className={`min-h-[44px] px-3 py-2 rounded-xl border text-left text-xs font-medium flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#0E6B5E] text-white border-[#0E6B5E]'
                        : 'bg-[#F6F8F7] text-[#2F413D] border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <span className="truncate">{VULNERABILITY_LABELS[vId]}</span>
                    {active && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Column 2: Commute & Home Cooking / Ventilation Setup */}
        <section className="lg:col-span-6 bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-6">
          {/* Commute Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-[#0F1D1A]">
              <Car className="w-4 h-4 text-[#0E6B5E]" aria-hidden="true" />
              <span>02. Daily Commute Baseline</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="commuteType" className="block text-xs font-semibold text-[#4B5E59]">
                  Primary Commute Mode
                </label>
                <select
                  id="commuteType"
                  value={draft.commuteType}
                  onChange={(e) =>
                    setDraft({ ...draft, commuteType: e.target.value as CommuteType })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="DRIVE">Personal Car / Rideshare</option>
                  <option value="TRANSIT">Public Transit (Bus / Rail)</option>
                  <option value="BICYCLE">Bicycle / E-Bike</option>
                  <option value="WALK">Walking</option>
                  <option value="HYBRID">Mixed / Hybrid Week</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vehicleEmissionType" className="block text-xs font-semibold text-[#4B5E59]">
                  Household Vehicle Type
                </label>
                <select
                  id="vehicleEmissionType"
                  value={draft.vehicleEmissionType}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      vehicleEmissionType: e.target.value as VehicleEmissionType,
                    })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="GASOLINE">Gasoline</option>
                  <option value="HYBRID">Hybrid</option>
                  <option value="DIESEL">Diesel</option>
                  <option value="ELECTRIC">Electric (EV)</option>
                  <option value="NONE">No Household Car</option>
                </select>
              </div>
            </div>
          </div>

          {/* Cooking & Ventilation Section */}
          <div className="pt-5 border-t border-slate-100 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-[#0F1D1A]">
              <Flame className="w-4 h-4 text-[#0E6B5E]" aria-hidden="true" />
              <span>03. Home Cooking &amp; Ventilation Setup</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="cookingSetup" className="block text-xs font-semibold text-[#4B5E59]">
                  Cooking Stove
                </label>
                <select
                  id="cookingSetup"
                  value={draft.cookingSetup}
                  onChange={(e) =>
                    setDraft({ ...draft, cookingSetup: e.target.value as CookingSetup })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="GAS_STOVE">Gas Range / Burners</option>
                  <option value="INDUCTION_ELECTRIC">Induction / Electric</option>
                  <option value="WOOD_BIOMASS">Wood / Solid Fuel</option>
                  <option value="MIXED">Mixed Gas + Electric</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="rangeHood" className="block text-xs font-semibold text-[#4B5E59]">
                  Range Hood
                </label>
                <select
                  id="rangeHood"
                  value={draft.rangeHood}
                  onChange={(e) =>
                    setDraft({ ...draft, rangeHood: e.target.value as RangeHoodType })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="VENTED_OUTDOORS">Ducted / Vented Outdoors</option>
                  <option value="RECIRCULATING">Recirculating (Unvented)</option>
                  <option value="NONE">No Range Hood</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="airPurifier" className="block text-xs font-semibold text-[#4B5E59]">
                  Indoor Air Purifier
                </label>
                <select
                  id="airPurifier"
                  value={draft.airPurifier}
                  onChange={(e) =>
                    setDraft({ ...draft, airPurifier: e.target.value as AirPurifierType })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="HEPA_MAIN_ROOMS">HEPA in Main Rooms</option>
                  <option value="SINGLE_ROOM">Single Bedroom Purifier</option>
                  <option value="NONE">No Air Purifier</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="windowVentilation" className="block text-xs font-semibold text-[#4B5E59]">
                  Window Exposure
                </label>
                <select
                  id="windowVentilation"
                  value={draft.windowVentilation}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      windowVentilation: e.target.value as WindowVentilationType,
                    })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm text-[#0F1D1A] focus:outline-none focus:border-[#0E6B5E]"
                >
                  <option value="STREET_FACING">Faces Busy Street</option>
                  <option value="CROSS_VENTILATION">Cross-Ventilation (2+ Sides)</option>
                  <option value="SINGLE_SIDE">Single-Side Apartment</option>
                  <option value="SEALED_HVAC">Sealed / Central HVAC</option>
                </select>
              </div>
            </div>
          </div>

          {saveError && (
            <div
              role="alert"
              className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-800"
            >
              {saveError}
            </div>
          )}

          {saveMessage && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900"
            >
              {saveMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-[#0E6B5E] text-white text-sm font-semibold hover:bg-[#0A5248] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving Profile...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Family Profile
              </>
            )}
          </button>
        </section>
      </div>
    </form>
  );
};
