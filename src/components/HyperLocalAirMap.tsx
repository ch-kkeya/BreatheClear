import React, { useEffect, useState } from 'react';
import {
  Map as GoogleMap,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Wind,
  Droplets,
  Thermometer,
  LocateFixed,
  RefreshCw,
  Layers,
  Clock,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react';
import type { AirQualityOverview, FamilyProfile, VentilationHourSlot } from '../types';
import { getAqiTone, VULNERABILITY_LABELS } from '../lib/aqiUtils';
import { PlaceSearchInput } from './PlaceSearchInput';

type HeatmapLayerOption = 'US_AQI' | 'PM25_INDIGO_PERSIAN' | 'OFF';

interface HyperLocalAirMapProps {
  profile: FamilyProfile;
  overview: AirQualityOverview | null;
  isLoading: boolean;
  error: string | null;
  inspectedCoords: { lat: number; lng: number; label: string };
  onSelectCoords: (coords: { lat: number; lng: number; label: string }) => void;
  onRefresh: () => void;
  onLocateMe: () => void;
  isLocating: boolean;
}

/**
 * Renders the 500m Hyper-Local Radius Circle and the live Google Air Quality API
 * raster heatmap tile overlay directly onto the @vis.gl/react-google-maps instance.
 */
const MapOverlays: React.FC<{
  lat: number;
  lng: number;
  ringColor: string;
  heatmapLayer: HeatmapLayerOption;
  dataSource: 'google' | 'open-meteo';
  usAqi: number;
}> = ({ lat, lng, ringColor, heatmapLayer, dataSource, usAqi }) => {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const coreLib = useMapsLibrary('core');

  // Pan smoothly when inspected coordinates change
  useEffect(() => {
    if (!map) return;
    map.panTo({ lat, lng });
  }, [map, lat, lng]);

  // 500m Hyper-Local Radius Ring + Concentric Atmospheric Plume when using Open-Meteo
  useEffect(() => {
    if (!map || !mapsLib) return;
    const circles: google.maps.Circle[] = [];

    const coreCircle = new mapsLib.Circle({
      map,
      center: { lat, lng },
      radius: 500,
      strokeColor: ringColor,
      strokeOpacity: 0.92,
      strokeWeight: 2,
      fillColor: ringColor,
      fillOpacity: heatmapLayer === 'OFF' ? 0.1 : 0.18,
      clickable: false,
    });
    circles.push(coreCircle);

    if (dataSource === 'open-meteo' && heatmapLayer !== 'OFF') {
      const plumeColor = heatmapLayer === 'PM25_INDIGO_PERSIAN' ? '#4F46E5' : ringColor;
      const intensityBoost = Math.min(0.14, Math.max(0.05, usAqi / 650));

      circles.push(
        new mapsLib.Circle({
          map,
          center: { lat, lng },
          radius: 1150,
          strokeColor: plumeColor,
          strokeOpacity: 0.35,
          strokeWeight: 1,
          fillColor: plumeColor,
          fillOpacity: intensityBoost,
          clickable: false,
        }),
        new mapsLib.Circle({
          map,
          center: { lat, lng },
          radius: 2100,
          strokeColor: plumeColor,
          strokeOpacity: 0.16,
          strokeWeight: 1,
          fillColor: plumeColor,
          fillOpacity: intensityBoost * 0.55,
          clickable: false,
        })
      );
    }

    return () => {
      circles.forEach((c) => c.setMap(null));
    };
  }, [map, mapsLib, lat, lng, ringColor, heatmapLayer, dataSource, usAqi]);

  // Live Google Air Quality Heatmap Tiles (active only when Google AQ API is the data source)
  useEffect(() => {
    if (!map || !mapsLib || !coreLib) return;
    map.overlayMapTypes.clear();

    if (heatmapLayer === 'OFF' || dataSource !== 'google') return;

    const imageMapType = new mapsLib.ImageMapType({
      getTileUrl: (coord: google.maps.Point | null, zoom: number) => {
        if (!coord || zoom < 0 || zoom > 16) return null;
        const numTiles = 1 << zoom;
        if (coord.y < 0 || coord.y >= numTiles) return null;
        const x = ((coord.x % numTiles) + numTiles) % numTiles;
        return `/api/air-quality/tile/${heatmapLayer}/${zoom}/${x}/${coord.y}`;
      },
      tileSize: new coreLib.Size(256, 256),
      maxZoom: 16,
      minZoom: 0,
      name: 'Air Quality Heatmap',
      opacity: 0.52,
    });

    map.overlayMapTypes.insertAt(0, imageMapType);
    return () => {
      map.overlayMapTypes.clear();
    };
  }, [map, mapsLib, coreLib, heatmapLayer, dataSource]);

  return null;
};

export const HyperLocalAirMap: React.FC<HyperLocalAirMapProps> = ({
  profile,
  overview,
  isLoading,
  error,
  inspectedCoords,
  onSelectCoords,
  onRefresh,
  onLocateMe,
  isLocating,
}) => {
  const [heatmapLayer, setHeatmapLayer] = useState<HeatmapLayerOption>('US_AQI');
  const [selectedHourIdx, setSelectedHourIdx] = useState<number>(0);
  const [expandedPollutant, setExpandedPollutant] = useState<string | null>(null);

  useEffect(() => {
    setSelectedHourIdx(0);
  }, [overview?.fetchedAt]);

  const tone = getAqiTone(overview?.usAqi ?? 35);
  const selectedSlot: VentilationHourSlot | null =
    overview?.timeline?.[selectedHourIdx] || overview?.timeline?.[0] || null;

  const getHouseholdHealthAdvice = (): { audience: string; text: string } => {
    const recs = overview?.healthRecommendations || {};
    if (profile.vulnerabilities.includes('ASTHMA_COPD') && recs.lungDiseasePopulation) {
      return { audience: 'Asthma & Respiratory Guidance', text: recs.lungDiseasePopulation };
    }
    if (profile.vulnerabilities.includes('YOUNG_CHILDREN') && recs.children) {
      return { audience: 'Children & Family Guidance', text: recs.children };
    }
    if (profile.vulnerabilities.includes('SENIORS_65') && recs.elderly) {
      return { audience: 'Older Adults Guidance', text: recs.elderly };
    }
    if (profile.vulnerabilities.includes('PREGNANCY') && recs.pregnantWomen) {
      return { audience: 'Pregnancy Guidance', text: recs.pregnantWomen };
    }
    if (profile.vulnerabilities.includes('CARDIOVASCULAR') && recs.heartDiseasePopulation) {
      return { audience: 'Cardiovascular Guidance', text: recs.heartDiseasePopulation };
    }
    if (profile.vulnerabilities.includes('OUTDOOR_ATHLETE') && recs.athletes) {
      return { audience: 'Outdoor Activity Guidance', text: recs.athletes };
    }
    return {
      audience: 'Neighborhood Health Guidance',
      text:
        recs.generalPopulation ||
        'Outdoor air conditions are updated hourly from hyper-local monitoring.',
    };
  };

  const healthAdvice = getHouseholdHealthAdvice();

  const statusMeta = (status: VentilationHourSlot['status']) => {
    if (status === 'SAFE_OPEN') {
      return {
        label: 'Open Windows',
        textClass: 'text-emerald-800',
        barBg: 'bg-emerald-600',
        cardBorder: 'border-emerald-200 bg-emerald-50/70',
      };
    }
    if (status === 'BRIEF_PURGE') {
      return {
        label: 'Brief Purge',
        textClass: 'text-amber-800',
        barBg: 'bg-amber-500',
        cardBorder: 'border-amber-200 bg-amber-50/70',
      };
    }
    return {
      label: 'Keep Sealed',
      textClass: 'text-red-800',
      barBg: 'bg-red-600',
      cardBorder: 'border-red-200 bg-red-50/70',
    };
  };

  return (
    <div className="space-y-6">
      {/* Top Search & Quick Location Bar */}
      <section className="bg-white rounded-2xl border border-slate-200/90 p-4 sm:p-5">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex-1">
            <PlaceSearchInput
              value={inspectedCoords.label}
              biasLat={inspectedCoords.lat}
              biasLng={inspectedCoords.lng}
              placeholder="Inspect any 500m street block or neighborhood..."
              onSelect={(place) =>
                onSelectCoords({ lat: place.lat, lng: place.lng, label: place.label })
              }
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onLocateMe}
              disabled={isLocating}
              className="flex-1 md:flex-none inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl bg-[#F6F8F7] border border-slate-200 text-sm font-medium text-[#0F1D1A] hover:bg-slate-100 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LocateFixed className={`w-4 h-4 text-[#0E6B5E] ${isLocating ? 'animate-spin' : ''}`} />
              My Location
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="Refresh live air quality"
              className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xl bg-[#F6F8F7] border border-slate-200 text-[#0F1D1A] hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[#0E6B5E]' : ''}`} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#4B5E59]">
          <span>500m Radius Zone</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            {inspectedCoords.lat.toFixed(4)}, {inspectedCoords.lng.toFixed(4)}
          </span>
          {profile.vulnerabilities.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Calibrated for{' '}
                {profile.vulnerabilities
                  .slice(0, 3)
                  .map((v) => VULNERABILITY_LABELS[v])
                  .join(', ')}
              </span>
            </>
          )}
          {overview?.dataSource === 'open-meteo' && (
            <>
              <span aria-hidden="true">·</span>
              <span>Open-Meteo CAMS + Google Weather</span>
            </>
          )}
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3"
        >
          <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm text-red-900">
            <p className="font-semibold">Unable to load live air quality data</p>
            <p className="mt-0.5 text-red-800">{error}</p>
          </div>
        </div>
      )}

      {/* Main Responsive 2-Column Split: 500m Interactive Map + Live AQI Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left/Top: 500m Hyper-Local Air Quality & Smog Map */}
        <section
          aria-labelledby="map-section-heading"
          className="lg:col-span-7 bg-white rounded-2xl border border-slate-200/90 overflow-hidden flex flex-col"
        >
          <div className="px-4 sm:px-5 py-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="map-section-heading" className="text-base font-bold text-[#0F1D1A]">
                500m Hyper-Local Air &amp; Smog Map
              </h2>
              <p className="text-xs text-[#4B5E59] mt-0.5">
                Tap anywhere on the map to sample another 500m neighborhood pocket
              </p>
            </div>
            <div
              role="group"
              aria-label="Map overlay layer"
              className="flex items-center gap-1 p-1 bg-[#F6F8F7] rounded-xl border border-slate-200/70"
            >
              <Layers className="w-3.5 h-3.5 text-[#4B5E59] ml-2 mr-1 hidden sm:block" aria-hidden="true" />
              {(
                [
                  { id: 'US_AQI', label: 'US AQI' },
                  { id: 'PM25_INDIGO_PERSIAN', label: 'PM2.5' },
                  { id: 'OFF', label: 'Clean Map' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={heatmapLayer === opt.id}
                  onClick={() => setHeatmapLayer(opt.id)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    heatmapLayer === opt.id
                      ? 'bg-white text-[#0F1D1A] shadow-xs'
                      : 'text-[#4B5E59] hover:text-[#0F1D1A]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative w-full h-[330px] sm:h-[380px] lg:flex-1 lg:min-h-[420px]">
            <GoogleMap
              mapId="DEMO_MAP_ID"
              defaultCenter={{ lat: inspectedCoords.lat, lng: inspectedCoords.lng }}
              defaultZoom={14}
              gestureHandling="greedy"
              disableDefaultUI={false}
              streetViewControl={false}
              mapTypeControl={false}
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              onClick={(e) => {
                const latLng = e.detail.latLng;
                if (latLng) {
                  onSelectCoords({
                    lat: latLng.lat,
                    lng: latLng.lng,
                    label: `Sampled Spot (${latLng.lat.toFixed(3)}, ${latLng.lng.toFixed(3)})`,
                  });
                }
              }}
              style={{ width: '100%', height: '100%' }}
            >
              <MapOverlays
                lat={inspectedCoords.lat}
                lng={inspectedCoords.lng}
                ringColor={tone.ringColor}
                heatmapLayer={heatmapLayer}
                dataSource={overview?.dataSource || 'open-meteo'}
                usAqi={overview?.usAqi ?? 35}
              />
              <AdvancedMarker position={{ lat: inspectedCoords.lat, lng: inspectedCoords.lng }}>
                <div
                  className="px-3 py-1.5 rounded-xl bg-white border-2 shadow-md flex items-center gap-2"
                  style={{ borderColor: tone.ringColor }}
                >
                  <span
                    className="font-mono tabular-nums text-sm font-bold"
                    style={{ color: tone.ringColor }}
                  >
                    {overview ? overview.usAqi : '—'}
                  </span>
                  <span className="text-[11px] font-semibold text-[#0F1D1A] whitespace-nowrap">
                    US AQI · 500m
                  </span>
                </div>
              </AdvancedMarker>
            </GoogleMap>
          </div>
        </section>

        {/* Right/Bottom: Live AQI & Weather Instrument Readout */}
        <section className="lg:col-span-5 bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 flex flex-col justify-between gap-5">
          {isLoading && !overview ? (
            <div className="space-y-4 animate-pulse py-6">
              <div className="h-4 w-32 bg-slate-200 rounded" />
              <div className="h-14 w-44 bg-slate-200 rounded-xl" />
              <div className="h-20 w-full bg-slate-100 rounded-xl" />
              <div className="h-24 w-full bg-slate-100 rounded-xl" />
            </div>
          ) : overview ? (
            <>
              <div>
                <div className="flex items-center justify-between gap-2 text-xs text-[#4B5E59]">
                  <span className="truncate">{inspectedCoords.label}</span>
                  <span className="font-mono tabular-nums shrink-0">
                    UAQI {overview.uaqi}/100
                  </span>
                </div>

                <div className="mt-3 flex items-baseline gap-4">
                  <div className="font-mono tabular-nums text-5xl sm:text-6xl font-bold tracking-tight text-[#0F1D1A]">
                    {overview.usAqi}
                  </div>
                  <div className="space-y-0.5">
                    <p className={`text-base font-bold ${tone.textClass}`}>{tone.label}</p>
                    <p className="text-xs text-[#4B5E59]">
                      Dominant: <strong className="text-[#0F1D1A]">{overview.dominantPollutantLabel}</strong>{' '}
                      <span aria-hidden="true">·</span>{' '}
                      <span className="font-mono tabular-nums">{overview.dominantConcentration}</span>
                    </p>
                  </div>
                </div>

                {/* AQI Scale Meter */}
                <div className="mt-4">
                  <div
                    role="progressbar"
                    aria-valuenow={overview.usAqi}
                    aria-valuemin={0}
                    aria-valuemax={500}
                    aria-label={`US Air Quality Index: ${overview.usAqi}, ${tone.label}`}
                    className="h-2 w-full rounded-full bg-slate-100 overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${tone.barClass}`}
                      style={{ width: `${Math.min(100, Math.max(6, (overview.usAqi / 200) * 100))}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] font-mono tabular-nums text-[#6B7E79]">
                    <span>0 Good</span>
                    <span>50 Mod</span>
                    <span>100 Sens</span>
                    <span>150+ Unhealthy</span>
                  </div>
                </div>
              </div>

              {/* Live Weather Micro-Climate Strip (Google Weather API) */}
              <div className="grid grid-cols-3 gap-3 pt-4 border-t border-slate-100">
                <div>
                  <div className="flex items-center gap-1 text-xs text-[#4B5E59]">
                    <Thermometer className="w-3.5 h-3.5 text-[#0E6B5E]" />
                    <span>Temp</span>
                  </div>
                  <p className="mt-1 font-mono tabular-nums text-lg font-semibold text-[#0F1D1A]">
                    {overview.weather.tempC !== null ? `${overview.weather.tempC}°C` : '—'}
                  </p>
                  <p className="text-[11px] text-[#6B7E79] truncate">
                    {overview.weather.conditionText || 'Live weather'}
                  </p>
                </div>

                <div>
                  <div className="flex items-center gap-1 text-xs text-[#4B5E59]">
                    <Wind className="w-3.5 h-3.5 text-[#0E6B5E]" />
                    <span>Wind</span>
                  </div>
                  <p className="mt-1 font-mono tabular-nums text-lg font-semibold text-[#0F1D1A]">
                    {overview.weather.windKph !== null ? `${overview.weather.windKph} km/h` : '—'}
                  </p>
                  <p className="text-[11px] text-[#6B7E79] truncate">
                    {overview.weather.windDirection || 'Dispersion'}
                  </p>
                </div>

                <div>
                  <div className="flex items-center gap-1 text-xs text-[#4B5E59]">
                    <Droplets className="w-3.5 h-3.5 text-[#0E6B5E]" />
                    <span>Humidity</span>
                  </div>
                  <p className="mt-1 font-mono tabular-nums text-lg font-semibold text-[#0F1D1A]">
                    {overview.weather.humidityPct !== null ? `${overview.weather.humidityPct}%` : '—'}
                  </p>
                  <p className="text-[11px] text-[#6B7E79] truncate">
                    Rain {overview.weather.precipChancePct ?? 0}%
                  </p>
                </div>
              </div>

              {/* Personalized Household Advisory */}
              <div className="pt-4 border-t border-slate-100 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#0E6B5E]">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{healthAdvice.audience}</span>
                </div>
                <p className="text-sm text-[#2F413D] leading-relaxed">{healthAdvice.text}</p>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {/* Safe Ventilation Window Timeline (Next 24h AQI + Weather Synthesis) */}
      {overview && (
        <section className="bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-[#0E6B5E]">
                <Clock className="w-4 h-4" />
                <span>Safe Ventilation Window · Next 24 Hours</span>
              </div>
              <h3 className="mt-1 text-xl font-bold text-[#0F1D1A]">
                {overview.bestVentilationWindow.label}
              </h3>
              <p className="mt-1 text-sm text-[#4B5E59] max-w-2xl">
                {overview.bestVentilationWindow.summary}
              </p>
            </div>
            <div className="text-xs text-[#4B5E59] shrink-0">
              <span>Safe ceiling: </span>
              <span className="font-mono tabular-nums font-semibold text-[#0F1D1A]">
                AQI ≤ {overview.sensitivityThresholdAqi}
              </span>
            </div>
          </div>

          {/* Interactive 24-Hour Horizontal Bar Strip */}
          {overview.timeline.length > 0 && (
            <>
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-subtle">
                {overview.timeline.map((slot, idx) => {
                  const meta = statusMeta(slot.status);
                  const isSelected = idx === selectedHourIdx;
                  const barHeight = Math.max(16, Math.min(72, Math.round((slot.usAqi / 150) * 72)));
                  return (
                    <button
                      key={slot.dateTime}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`${slot.localHourLabel}: AQI ${slot.usAqi}, ${meta.label}`}
                      onClick={() => setSelectedHourIdx(idx)}
                      className={`shrink-0 w-[64px] rounded-xl p-2 flex flex-col items-center justify-between gap-1.5 border transition-all cursor-pointer ${
                        isSelected
                          ? 'border-[#0E6B5E] bg-[#0E6B5E]/5 shadow-xs'
                          : 'border-slate-200/80 bg-[#F6F8F7]/60 hover:bg-[#F6F8F7]'
                      }`}
                    >
                      <span className="text-[11px] font-medium text-[#4B5E59] whitespace-nowrap">
                        {slot.localHourLabel}
                      </span>
                      <div className="h-[74px] w-full flex items-end justify-center">
                        <div
                          className={`w-5 rounded-t-md transition-all ${meta.barBg}`}
                          style={{ height: `${barHeight}px` }}
                        />
                      </div>
                      <span className="font-mono tabular-nums text-xs font-bold text-[#0F1D1A]">
                        {slot.usAqi}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Selected Hour Inspection Detail */}
              {selectedSlot && (
                <div
                  className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    statusMeta(selectedSlot.status).cardBorder
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="font-bold text-[#0F1D1A]">{selectedSlot.localHourLabel}</span>
                      <span aria-hidden="true" className="text-[#6B7E79]">·</span>
                      <span className={`font-semibold ${statusMeta(selectedSlot.status).textClass}`}>
                        {statusMeta(selectedSlot.status).label}
                      </span>
                      <span aria-hidden="true" className="text-[#6B7E79]">·</span>
                      <span className="font-mono tabular-nums text-xs text-[#2F413D]">
                        AQI {selectedSlot.usAqi} ({selectedSlot.dominantPollutant})
                      </span>
                    </div>
                    <p className="text-sm text-[#2F413D]">{selectedSlot.reason}</p>
                  </div>

                  <div className="flex items-center gap-4 text-xs font-mono tabular-nums text-[#2F413D] shrink-0">
                    {selectedSlot.tempC !== null && <span>{selectedSlot.tempC}°C</span>}
                    {selectedSlot.windKph !== null && <span>{selectedSlot.windKph} km/h</span>}
                    {selectedSlot.precipChancePct !== null && <span>{selectedSlot.precipChancePct}% rain</span>}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Measured Pollutants Breakdown */}
      {overview && overview.pollutants.length > 0 && (
        <section className="bg-white rounded-2xl border border-slate-200/90 p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-[#0F1D1A]">Hyper-Local Pollutant Breakdown</h3>
              <p className="text-xs text-[#4B5E59] mt-0.5">
                Tap any pollutant to inspect its urban emission sources and respiratory effects
              </p>
            </div>
            <CheckCircle2 className="w-4 h-4 text-[#0E6B5E] shrink-0" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {overview.pollutants.map((p) => {
              const isDom = p.code.toLowerCase() === overview.dominantPollutant.toLowerCase();
              const isSelected = expandedPollutant === p.code;
              return (
                <button
                  key={p.code}
                  type="button"
                  aria-expanded={isSelected}
                  onClick={() => setExpandedPollutant(isSelected ? null : p.code)}
                  className={`text-left rounded-xl p-3.5 border transition-colors cursor-pointer min-h-[84px] flex flex-col justify-between ${
                    isSelected
                      ? 'border-[#0E6B5E] bg-[#0E6B5E]/5'
                      : 'border-slate-200/80 bg-[#F6F8F7]/60 hover:bg-[#F6F8F7]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-[#0F1D1A]">{p.displayName}</span>
                    {isDom && (
                      <span className="text-[10px] font-semibold text-[#0E6B5E]">Dominant</span>
                    )}
                  </div>
                  <div className="mt-2">
                    <p className="font-mono tabular-nums text-lg font-bold text-[#0F1D1A]">
                      {p.value.toFixed(1)}
                    </p>
                    <p className="text-[11px] font-mono text-[#6B7E79]">{p.units}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {expandedPollutant && (() => {
            const p = overview.pollutants.find((item) => item.code === expandedPollutant);
            if (!p) return null;
            return (
              <div className="rounded-xl bg-[#F6F8F7] border border-slate-200 p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-bold text-[#0F1D1A]">
                  <Info className="w-4 h-4 text-[#0E6B5E]" />
                  <span>
                    {p.fullName} ({p.displayName}) — {p.value.toFixed(1)} {p.units}
                  </span>
                </div>
                {p.sources && (
                  <p className="text-xs text-[#2F413D] leading-relaxed">
                    <strong className="text-[#0F1D1A]">Typical Sources:</strong> {p.sources}
                  </p>
                )}
                {p.effects && (
                  <p className="text-xs text-[#2F413D] leading-relaxed">
                    <strong className="text-[#0F1D1A]">Health Effects:</strong> {p.effects}
                  </p>
                )}
              </div>
            );
          })()}
        </section>
      )}
    </div>
  );
};
