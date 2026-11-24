import React, { useRef, useState } from 'react';
import {
  Camera,
  Upload,
  CheckSquare,
  Square,
  AlertTriangle,
  Wind,
  Trash2,
  Loader2,
  Sparkles,
  Image as ImageIcon,
} from 'lucide-react';
import type { AirQualityOverview, FamilyProfile, RoomScanResult, RoomType } from '../types';
import { apiFetchJson, getRiskTone, imageSourceToCompressedBase64 } from '../lib/aqiUtils';
import { formatFirestoreDate } from '../lib/firebase';

const SAMPLE_ROOMS = [
  {
    id: 'sample-kitchen',
    label: 'Urban Gas Kitchen',
    roomType: 'KITCHEN' as RoomType,
    caption: 'Gas range, modest hood, city window',
    imageSrc: '/src/assets/images/sample_urban_kitchen_1795236320458.jpg',
  },
  {
    id: 'sample-bedroom',
    label: 'Street-Facing Bedroom',
    roomType: 'BEDROOM' as RoomType,
    caption: 'Double-hung window, curtains, street traffic',
    imageSrc: '/src/assets/images/sample_city_bedroom_1795236318100.jpg',
  },
];

const ROOM_TYPES: Array<{ id: RoomType; label: string }> = [
  { id: 'KITCHEN', label: 'Kitchen' },
  { id: 'BEDROOM', label: 'Bedroom' },
  { id: 'LIVING_ROOM', label: 'Living Room' },
  { id: 'WINDOW_BALCONY', label: 'Window / Balcony' },
  { id: 'KIDS_ROOM', label: 'Kids Room' },
  { id: 'HOME_OFFICE', label: 'Home Office' },
];

interface RoomIaqScannerProps {
  profile: FamilyProfile;
  overview: AirQualityOverview | null;
  savedScans: RoomScanResult[];
  isSignedIn: boolean;
  onSaveScan: (scan: Omit<RoomScanResult, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>) => Promise<string | null>;
  onToggleHack: (scanId: string, completedHackIds: string[]) => Promise<void>;
  onDeleteScan: (scanId: string) => Promise<void>;
  onSignInPrompt: () => void;
}

export const RoomIaqScanner: React.FC<RoomIaqScannerProps> = ({
  profile,
  overview,
  savedScans,
  isSignedIn,
  onSaveScan,
  onToggleHack,
  onDeleteScan,
  onSignInPrompt,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [roomType, setRoomType] = useState<RoomType>('KITCHEN');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ base64: string; mimeType: 'image/jpeg' } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<RoomScanResult | null>(null);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setError(null);
      const compressed = await imageSourceToCompressedBase64(file);
      setPreviewUrl(compressed.previewUrl);
      setPendingImage({ base64: compressed.base64, mimeType: compressed.mimeType });
      setActiveScan(null);
    } catch (err: any) {
      setError(err?.message || 'Could not process the uploaded photo.');
    }
  };

  const handleUseSample = async (sample: (typeof SAMPLE_ROOMS)[number]) => {
    try {
      setError(null);
      setRoomType(sample.roomType);
      const compressed = await imageSourceToCompressedBase64(sample.imageSrc);
      setPreviewUrl(compressed.previewUrl);
      setPendingImage({ base64: compressed.base64, mimeType: compressed.mimeType });
      setActiveScan(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load sample room image.');
    }
  };

  const handleRunScan = async () => {
    if (!pendingImage) {
      setError('Upload a room photo or select a sample room first.');
      return;
    }
    try {
      setIsAnalyzing(true);
      setError(null);

      const result = await apiFetchJson<Omit<RoomScanResult, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>>(
        '/api/iaq/scan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: pendingImage.base64,
            mimeType: pendingImage.mimeType,
            roomType,
            outdoorAqi: overview?.usAqi ?? 42,
            dominantPollutant: overview?.dominantPollutantLabel ?? 'PM2.5',
            familyProfile: profile,
          }),
        }
      );

      let savedId: string | null = null;
      if (isSignedIn) {
        savedId = await onSaveScan(result);
      }

      setActiveScan({
        ...result,
        id: savedId || `local-${Date.now()}`,
        ownerId: profile.ownerId,
      });
    } catch (err: any) {
      setError(err?.message || 'Indoor air quality scan failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleHackToggle = async (hackId: string) => {
    if (!activeScan) return;
    const exists = activeScan.completedHackIds.includes(hackId);
    const updated = exists
      ? activeScan.completedHackIds.filter((id) => id !== hackId)
      : [...activeScan.completedHackIds, hackId];

    setActiveScan({ ...activeScan, completedHackIds: updated });

    if (isSignedIn && activeScan.id && !activeScan.id.startsWith('local-')) {
      await onToggleHack(activeScan.id, updated);
    }
  };

  const activeRiskTone = activeScan ? getRiskTone(activeScan.overallRiskLevel) : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Camera Upload & Sample Selector */}
        <section className="lg:col-span-5 bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="text-lg font-bold text-[#0F1D1A]">Snap-a-Room IAQ Scanner</h2>
            <p className="mt-1 text-sm text-[#4B5E59] leading-relaxed">
              Upload a photo of a kitchen, bedroom, or window. BreatheClear spots pollution risks
              and returns 3 zero-cost or low-cost indoor air hacks tailored to your home.
            </p>
          </div>

          {/* Room Type Segmented Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-[#4B5E59]">Room Type</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ROOM_TYPES.map((rt) => (
                <button
                  key={rt.id}
                  type="button"
                  onClick={() => setRoomType(rt.id)}
                  className={`min-h-[40px] px-2.5 py-2 rounded-xl text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap truncate ${
                    roomType === rt.id
                      ? 'bg-[#0E6B5E] text-white border-[#0E6B5E]'
                      : 'bg-[#F6F8F7] text-[#2F413D] border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {rt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Photo Capture / Preview Box */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />

          {previewUrl ? (
            <div className="space-y-3">
              <div className="relative rounded-xl overflow-hidden border border-slate-200 aspect-[4/3] bg-slate-100">
                <img
                  src={previewUrl}
                  alt="Selected room for indoor air quality scan"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-3 right-3 px-3.5 py-2 min-h-[40px] rounded-xl bg-white/95 text-[#0F1D1A] text-xs font-semibold shadow-sm hover:bg-white transition-colors cursor-pointer"
                >
                  Change Photo
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-2xl border-2 border-dashed border-slate-300 bg-[#F6F8F7]/70 hover:bg-[#F6F8F7] hover:border-[#0E6B5E]/60 transition-colors p-7 flex flex-col items-center justify-center text-center gap-2.5 cursor-pointer min-h-[190px]"
            >
              <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-[#0E6B5E]">
                <Camera className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[#0F1D1A]">
                  Take a room photo or upload from device
                </p>
                <p className="text-xs text-[#4B5E59] mt-0.5">
                  Kitchen stoves, bedroom windows, nurseries, or vents
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0E6B5E] mt-1">
                <Upload className="w-3.5 h-3.5" />
                Choose Image
              </span>
            </button>
          )}

          {/* Built-in Sample Room Quick-Try Cards */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#4B5E59]">Or try a sample urban room</p>
            <div className="grid grid-cols-2 gap-3">
              {SAMPLE_ROOMS.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => void handleUseSample(sample)}
                  className="group text-left rounded-xl border border-slate-200 overflow-hidden bg-[#F6F8F7]/50 hover:border-[#0E6B5E] transition-colors cursor-pointer"
                >
                  <div className="aspect-[4/3] w-full bg-slate-200 overflow-hidden relative">
                    {!failedImages[sample.id] ? (
                      <img
                        src={sample.imageSrc}
                        alt={sample.label}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setFailedImages((prev) => ({ ...prev, [sample.id]: true }))
                        }
                        className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-100 flex flex-col items-center justify-center p-2 text-[#4B5E59]">
                        <ImageIcon className="w-5 h-5 mb-1" />
                        <span className="text-[11px] font-medium">{sample.label}</span>
                      </div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs font-semibold text-[#0F1D1A] truncate">{sample.label}</p>
                    <p className="text-[11px] text-[#4B5E59] truncate mt-0.5">{sample.caption}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-800">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleRunScan()}
            disabled={isAnalyzing || !pendingImage}
            className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-[#0E6B5E] text-white text-sm font-semibold hover:bg-[#0A5248] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing Room Pollution Risks...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Analyze Indoor Air Quality
              </>
            )}
          </button>
        </section>

        {/* Right: Gemini Vision IAQ Report & 3 Low-Cost Hacks */}
        <section className="lg:col-span-7 space-y-5">
          {activeScan && activeRiskTone ? (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-6">
              {/* Report Header */}
              <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-100">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#4B5E59]">
                    <span className="font-semibold text-[#0F1D1A]">
                      {activeScan.roomType.replace(/_/g, ' ')}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className={`font-semibold ${activeRiskTone.textClass}`}>
                      {activeRiskTone.label}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Outdoor AQI {activeScan.outdoorAqiAtScan}
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-[#0F1D1A]">Room Air Quality Audit</h3>
                </div>
                {!isSignedIn && (
                  <button
                    type="button"
                    onClick={onSignInPrompt}
                    className="text-xs font-semibold text-[#0E6B5E] hover:underline cursor-pointer"
                  >
                    Sign in to save history
                  </button>
                )}
              </div>

              {/* Observation Summary + Outdoor-Aware Ventilation */}
              <div className="space-y-4">
                <p className="text-sm text-[#2F413D] leading-relaxed">{activeScan.roomSummary}</p>

                <div className="rounded-xl bg-[#F6F8F7] border border-slate-200/80 p-4 flex items-start gap-3">
                  <Wind className="w-4 h-4 text-[#0E6B5E] shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="text-xs font-bold text-[#0F1D1A]">Ventilation Timing Advice</p>
                    <p className="text-sm text-[#2F413D] leading-relaxed">
                      {activeScan.ventilationAdvice}
                    </p>
                  </div>
                </div>
              </div>

              {/* Detected Pollution Risks */}
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-[#0F1D1A]">Detected Indoor Pollution Risks</h4>
                <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-xl overflow-hidden">
                  {activeScan.detectedRisks.map((risk, i) => {
                    const rTone = getRiskTone(risk.severity);
                    return (
                      <div key={i} className="p-3.5 sm:p-4 bg-white space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[#0F1D1A]">{risk.source}</span>
                          <span className={`text-xs font-semibold ${rTone.textClass}`}>
                            {risk.pollutantType} · {rTone.label}
                          </span>
                        </div>
                        <p className="text-xs sm:text-sm text-[#4B5E59] leading-relaxed">
                          {risk.explanation}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 3 Zero-Cost / Low-Cost IAQ Hacks */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-[#0F1D1A]">
                    3 Zero-Cost &amp; Low-Cost Indoor Air Hacks
                  </h4>
                  <span className="text-xs font-mono tabular-nums text-[#4B5E59]">
                    {activeScan.completedHackIds.length}/{activeScan.hacks.length} applied
                  </span>
                </div>

                <div className="space-y-3">
                  {activeScan.hacks.map((hack, idx) => {
                    const checked = activeScan.completedHackIds.includes(hack.id);
                    return (
                      <div
                        key={hack.id}
                        className={`rounded-xl border p-4 transition-colors ${
                          checked
                            ? 'bg-emerald-50/50 border-emerald-200'
                            : 'bg-white border-slate-200/90'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => void handleHackToggle(hack.id)}
                            aria-label={`Mark hack ${idx + 1} complete`}
                            className="mt-0.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-[#0E6B5E] cursor-pointer shrink-0"
                          >
                            {checked ? (
                              <CheckSquare className="w-5 h-5" />
                            ) : (
                              <Square className="w-5 h-5 text-slate-400" />
                            )}
                          </button>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span
                                className={`text-sm font-bold ${
                                  checked ? 'line-through text-[#4B5E59]' : 'text-[#0F1D1A]'
                                }`}
                              >
                                0{idx + 1}. {hack.title}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 text-xs text-[#0E6B5E] font-medium">
                              <span>{hack.costTier}</span>
                              <span aria-hidden="true">·</span>
                              <span>{hack.estimatedImpact}</span>
                            </div>
                            <p className="text-sm text-[#2F413D] leading-relaxed">{hack.steps}</p>
                            <p className="text-xs text-[#4B5E59] leading-relaxed">
                              Why it works: {hack.whyItWorks}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[#F6F8F7] text-[#0E6B5E] flex items-center justify-center mx-auto">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-[#0F1D1A]">Ready to inspect your indoor air</h3>
              <p className="text-sm text-[#4B5E59] max-w-md mx-auto leading-relaxed">
                Select a room photo or tap either sample room on the left, then run the scan to
                spot hidden NO₂, PM2.5, and airflow bottlenecks.
              </p>
            </div>
          )}

          {/* Saved Room Scan History (Firestore) */}
          {isSignedIn && savedScans.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200/90 p-5 space-y-3">
              <h3 className="text-sm font-bold text-[#0F1D1A]">Saved Household Room Audits</h3>
              <div className="divide-y divide-slate-100">
                {savedScans.map((scan) => {
                  const rTone = getRiskTone(scan.overallRiskLevel);
                  return (
                    <div
                      key={scan.id}
                      className="py-3 flex items-center justify-between gap-3"
                    >
                      <button
                        type="button"
                        onClick={() => setActiveScan(scan)}
                        className="text-left flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-[#4B5E59]">
                          <span className="font-semibold text-[#0F1D1A]">
                            {scan.roomType.replace(/_/g, ' ')}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className={`font-semibold ${rTone.textClass}`}>{rTone.label}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatFirestoreDate(scan.createdAt)}</span>
                        </div>
                        <p className="text-xs text-[#4B5E59] truncate mt-0.5">{scan.roomSummary}</p>
                      </button>
                      {scan.id && (
                        <button
                          type="button"
                          aria-label="Delete saved scan"
                          onClick={() => {
                            if (activeScan?.id === scan.id) setActiveScan(null);
                            void onDeleteScan(scan.id!);
                          }}
                          className="min-w-[40px] min-h-[40px] flex items-center justify-center text-slate-400 hover:text-red-700 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
