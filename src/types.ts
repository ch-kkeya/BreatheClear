export type CommuteType = 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK' | 'HYBRID';
export type VehicleEmissionType = 'GASOLINE' | 'DIESEL' | 'HYBRID' | 'ELECTRIC' | 'NONE';
export type CookingSetup = 'GAS_STOVE' | 'INDUCTION_ELECTRIC' | 'WOOD_BIOMASS' | 'MIXED';
export type RangeHoodType = 'VENTED_OUTDOORS' | 'RECIRCULATING' | 'NONE';
export type AirPurifierType = 'HEPA_MAIN_ROOMS' | 'SINGLE_ROOM' | 'NONE';
export type WindowVentilationType = 'CROSS_VENTILATION' | 'SINGLE_SIDE' | 'STREET_FACING' | 'SEALED_HVAC';

export type VulnerabilityId =
  | 'ASTHMA_COPD'
  | 'YOUNG_CHILDREN'
  | 'SENIORS_65'
  | 'PREGNANCY'
  | 'CARDIOVASCULAR'
  | 'OUTDOOR_ATHLETE';

export interface FamilyProfile {
  ownerId: string;
  householdName: string;
  locationLabel: string;
  lat: number;
  lng: number;
  vulnerabilities: VulnerabilityId[];
  commuteType: CommuteType;
  vehicleEmissionType: VehicleEmissionType;
  cookingSetup: CookingSetup;
  rangeHood: RangeHoodType;
  airPurifier: AirPurifierType;
  windowVentilation: WindowVentilationType;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PollutantDetail {
  code: string;
  displayName: string;
  fullName: string;
  value: number;
  units: string;
  sources?: string;
  effects?: string;
}

export interface VentilationHourSlot {
  dateTime: string;
  localHourLabel: string;
  usAqi: number;
  uaqi: number;
  category: string;
  dominantPollutant: string;
  tempC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  precipChancePct: number | null;
  weatherText: string | null;
  status: 'SAFE_OPEN' | 'BRIEF_PURGE' | 'KEEP_SEALED';
  reason: string;
}

export interface AirQualityOverview {
  fetchedAt: string;
  lat: number;
  lng: number;
  usAqi: number;
  uaqi: number;
  category: string;
  dataSource?: 'google' | 'open-meteo';
  dominantPollutant: string;
  dominantPollutantLabel: string;
  dominantConcentration: string;
  pollutants: PollutantDetail[];
  healthRecommendations: Record<string, string>;
  weather: {
    tempC: number | null;
    feelsLikeC: number | null;
    humidityPct: number | null;
    windKph: number | null;
    windDirection: string | null;
    conditionText: string | null;
    precipChancePct: number | null;
    uvIndex: number | null;
  };
  bestVentilationWindow: {
    hasSafeWindow: boolean;
    label: string;
    summary: string;
    startHourLabel: string | null;
    endHourLabel: string | null;
    avgAqi: number | null;
  };
  timeline: VentilationHourSlot[];
  sensitivityThresholdAqi: number;
}

export type RoomType =
  | 'KITCHEN'
  | 'BEDROOM'
  | 'LIVING_ROOM'
  | 'WINDOW_BALCONY'
  | 'KIDS_ROOM'
  | 'HOME_OFFICE';

export type RiskLevel = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';

export interface DetectedIaqRisk {
  source: string;
  pollutantType: string;
  severity: RiskLevel;
  explanation: string;
}

export interface IaqHack {
  id: string;
  title: string;
  costTier: 'Zero Cost' | 'Under $15' | 'Under $40';
  estimatedImpact: string;
  steps: string;
  whyItWorks: string;
}

export interface RoomScanResult {
  id?: string;
  ownerId: string;
  roomType: RoomType;
  overallRiskLevel: RiskLevel;
  roomSummary: string;
  outdoorAqiAtScan: number;
  ventilationAdvice: string;
  detectedRisks: DetectedIaqRisk[];
  hacks: IaqHack[];
  completedHackIds: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ScheduleItemInput {
  id: string;
  time: string;
  title: string;
  destinationQuery: string;
  destinationLat?: number;
  destinationLng?: number;
  currentMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK';
}

export interface RouteAlternativeSummary {
  mode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK';
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  fuelMicroliters?: number;
  isEcoRoute?: boolean;
}

export interface VerifiedPlaceRef {
  name: string;
  address: string;
  lat: number;
  lng: number;
  googleMapsUri?: string;
  placeType?: string;
}

export interface RoutineSwapItem {
  id: string;
  time: string;
  title: string;
  destinationName: string;
  destinationAddress: string;
  destinationLat: number;
  destinationLng: number;
  destinationMapsUri?: string;
  currentMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK';
  recommendedMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK';
  recommendedTimeWindow: string;
  swapHeadline: string;
  swapRationale: string;
  distanceKm: number;
  currentDurationMin: number;
  recommendedDurationMin: number;
  baselinePolyline: string;
  recommendedPolyline: string;
  nearbyCleanStop?: VerifiedPlaceRef | null;
  personalPm25UgSaved: number;
  personalPm25ReductionPct: number;
  communityCo2GramsSaved: number;
  communityNoxMgSaved: number;
}

export interface RoutinePlan {
  id?: string;
  ownerId: string;
  planTitle: string;
  locationLabel: string;
  swaps: RoutineSwapItem[];
  acceptedSwapIds: string[];
  personalPm25ReductionPct: number;
  personalPm25UgSaved: number;
  communityCo2GramsSaved: number;
  communityNoxMgSaved: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export const DEFAULT_FAMILY_PROFILE: FamilyProfile = {
  ownerId: 'local-guest',
  householdName: 'My Household',
  locationLabel: 'Mission District, San Francisco, CA',
  lat: 37.7599,
  lng: -122.4148,
  vulnerabilities: ['ASTHMA_COPD', 'YOUNG_CHILDREN'],
  commuteType: 'DRIVE',
  vehicleEmissionType: 'GASOLINE',
  cookingSetup: 'GAS_STOVE',
  rangeHood: 'RECIRCULATING',
  airPurifier: 'SINGLE_ROOM',
  windowVentilation: 'STREET_FACING',
};
