import { GoogleGenAI, Type } from '@google/genai';
import type { ScheduleItemInput, VehicleEmissionType, VerifiedPlaceRef } from '../types';
import {
  buildAirQualityOverviewFromRaw,
  buildRoomScanPrompt,
  buildRoutinePlanPrompt,
  computeCommuteLegImpact,
  mergeSwapsWithGeminiAdvice,
  parseDurationSeconds,
  sanitizeRoomScanResponse,
  type ComputedRouteMetrics,
  type GeminiRoutineAdvicePayload,
  type GoogleWeatherHourlyPayload,
  type GoogleWeatherHourSlotPayload,
  type OpenMeteoResponsePayload,
} from './airQualityDomain';

interface RuntimeEnvMeta {
  VITE_GOOGLE_MAPS_API_KEY?: string;
  VITE_AI_RUNTIME_TOKEN?: string;
}

function getRuntimeEnv(): RuntimeEnvMeta {
  return import.meta.env as unknown as RuntimeEnvMeta;
}

function getBrowserMapsApiKey(): string {
  return (getRuntimeEnv().VITE_GOOGLE_MAPS_API_KEY || '').trim();
}

function getBrowserGeminiClient(): GoogleGenAI {
  const apiKey = (getRuntimeEnv().VITE_AI_RUNTIME_TOKEN || '').trim();
  if (!apiKey) {
    throw new Error('AI service is not configured for static hosting.');
  }
  return new GoogleGenAI({ apiKey });
}

async function generateContentWithModelFallback(
  ai: GoogleGenAI,
  models: string[],
  params: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>
) {
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await ai.models.generateContent({ ...params, model });
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: unknown }).status)
          : 0;
      if (
        status === 404 ||
        msg.includes('not found') ||
        msg.includes('NOT_FOUND') ||
        msg.includes('not supported')
      ) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

interface GooglePlacesApiItem {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
  primaryTypeDisplayName?: { text?: string };
}

interface GoogleRoutesApiItem {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  routeLabels?: string[];
  travelAdvisory?: { fuelConsumptionMicroliters?: number };
}

/**
 * Fallback execution layer when BreatheClear is hosted on static Google Firebase Hosting
 * where Express /api/* endpoints are not running. Reuses the shared airQualityDomain module.
 */
export async function handleClientApiFallback<T>(url: string, options?: RequestInit): Promise<T> {
  const body: Record<string, unknown> = options?.body
    ? (JSON.parse(String(options.body)) as Record<string, unknown>)
    : {};

  if (url.startsWith('/api/config')) {
    return { mapsApiKey: getBrowserMapsApiKey() } as unknown as T;
  }

  if (url.startsWith('/api/air-quality/overview')) {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const vulnerabilities: string[] = Array.isArray(body.vulnerabilities)
      ? body.vulnerabilities.map(String)
      : [];
    const apiKey = getBrowserMapsApiKey();

    const openMeteoUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
    openMeteoUrl.searchParams.set('latitude', String(lat));
    openMeteoUrl.searchParams.set('longitude', String(lng));
    openMeteoUrl.searchParams.set(
      'current',
      'us_aqi,european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,us_aqi_pm2_5,us_aqi_pm10,us_aqi_nitrogen_dioxide,us_aqi_ozone,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide'
    );
    openMeteoUrl.searchParams.set(
      'hourly',
      'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,us_aqi_nitrogen_dioxide'
    );
    openMeteoUrl.searchParams.set('forecast_days', '2');
    openMeteoUrl.searchParams.set('timezone', 'GMT');

    const weatherCurrentUrl = new URL(
      'https://weather.googleapis.com/v1/currentConditions:lookup'
    );
    weatherCurrentUrl.searchParams.set('key', apiKey);
    weatherCurrentUrl.searchParams.set('location.latitude', String(lat));
    weatherCurrentUrl.searchParams.set('location.longitude', String(lng));
    weatherCurrentUrl.searchParams.set('unitsSystem', 'METRIC');

    const weatherHourlyUrl = new URL('https://weather.googleapis.com/v1/forecast/hours:lookup');
    weatherHourlyUrl.searchParams.set('key', apiKey);
    weatherHourlyUrl.searchParams.set('location.latitude', String(lat));
    weatherHourlyUrl.searchParams.set('location.longitude', String(lng));
    weatherHourlyUrl.searchParams.set('hours', '24');
    weatherHourlyUrl.searchParams.set('pageSize', '24');

    const [omRes, weatherCurrRes, weatherHourlyRes] = await Promise.all([
      fetch(openMeteoUrl.toString()),
      apiKey ? fetch(weatherCurrentUrl.toString()).catch(() => null) : Promise.resolve(null),
      apiKey ? fetch(weatherHourlyUrl.toString()).catch(() => null) : Promise.resolve(null),
    ]);

    if (!omRes.ok) {
      throw new Error(`Open-Meteo Air Quality API error (${omRes.status})`);
    }
    const omData = (await omRes.json()) as OpenMeteoResponsePayload;
    const weatherCurr =
      weatherCurrRes && weatherCurrRes.ok
        ? ((await weatherCurrRes.json()) as GoogleWeatherHourSlotPayload)
        : null;
    const weatherHourly =
      weatherHourlyRes && weatherHourlyRes.ok
        ? ((await weatherHourlyRes.json()) as GoogleWeatherHourlyPayload)
        : { forecastHours: [] };

    return buildAirQualityOverviewFromRaw({
      lat,
      lng,
      vulnerabilities,
      openMeteoData: omData,
      weatherCurr,
      weatherHourly,
    }) as unknown as T;
  }

  if (url.startsWith('/api/places/search')) {
    const query = String(body.query || '').trim();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const radiusMeters = Math.min(50000, Math.max(500, Number(body.radiusMeters || 8000)));
    const apiKey = getBrowserMapsApiKey();
    if (!apiKey) throw new Error('Google Maps API key not configured.');

    const reqBody: Record<string, unknown> = {
      textQuery: query,
      pageSize: 5,
      languageCode: 'en',
    };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      reqBody.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      };
    }

    const placeRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
      },
      body: JSON.stringify(reqBody),
    });
    if (!placeRes.ok) {
      throw new Error(`Places API error (${placeRes.status})`);
    }
    const parsed = (await placeRes.json()) as { places?: GooglePlacesApiItem[] };
    const places = (parsed.places || []).map((p) => ({
      id: p.id,
      name: p.displayName?.text || query,
      address: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      googleMapsUri: p.googleMapsUri || '',
      placeType: p.primaryTypeDisplayName?.text || '',
    }));
    return { places } as unknown as T;
  }

  if (url.startsWith('/api/iaq/scan')) {
    const imageBase64 = String(body.imageBase64 || '');
    const mimeType = String(body.mimeType || 'image/jpeg');
    const roomType = String(body.roomType || 'KITCHEN');
    const outdoorAqi = Number(body.outdoorAqi ?? 40);
    const dominantPollutant = String(body.dominantPollutant || 'PM2.5');
    const familyProfile = (body.familyProfile || {}) as Record<string, unknown>;

    const ai = getBrowserGeminiClient();
    const prompt = buildRoomScanPrompt({
      roomType,
      outdoorAqi,
      dominantPollutant,
      familyProfile: {
        vulnerabilities: Array.isArray(familyProfile.vulnerabilities)
          ? familyProfile.vulnerabilities.map(String)
          : [],
        cookingSetup: String(familyProfile.cookingSetup || 'Unknown'),
        rangeHood: String(familyProfile.rangeHood || 'Unknown'),
        airPurifier: String(familyProfile.airPurifier || 'Unknown'),
        windowVentilation: String(familyProfile.windowVentilation || 'Unknown'),
      },
    });

    const response = await generateContentWithModelFallback(
      ai,
      ['gemini-4-hydrogen', 'gemini-3.5-flash-lite'],
      {
        contents: {
          parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              roomSummary: { type: Type.STRING },
              overallRiskLevel: {
                type: Type.STRING,
                enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'],
              },
              ventilationAdvice: { type: Type.STRING },
              detectedRisks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING },
                    pollutantType: { type: Type.STRING },
                    severity: {
                      type: Type.STRING,
                      enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'],
                    },
                    explanation: { type: Type.STRING },
                  },
                  required: ['source', 'pollutantType', 'severity', 'explanation'],
                },
              },
              hacks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    costTier: {
                      type: Type.STRING,
                      enum: ['Zero Cost', 'Under $15', 'Under $40'],
                    },
                    estimatedImpact: { type: Type.STRING },
                    steps: { type: Type.STRING },
                    whyItWorks: { type: Type.STRING },
                  },
                  required: ['id', 'title', 'costTier', 'estimatedImpact', 'steps', 'whyItWorks'],
                },
              },
            },
            required: [
              'roomSummary',
              'overallRiskLevel',
              'ventilationAdvice',
              'detectedRisks',
              'hacks',
            ],
          },
        },
      }
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
    return sanitizeRoomScanResponse(parsed, roomType, outdoorAqi) as unknown as T;
  }

  if (url.startsWith('/api/routine/plan')) {
    const homeLocation = (body.homeLocation || {}) as {
      label?: string;
      lat?: number;
      lng?: number;
    };
    const schedule = Array.isArray(body.schedule)
      ? (body.schedule as Array<Partial<ScheduleItemInput>>).slice(0, 6)
      : [];
    const familyProfile = (body.familyProfile || {}) as {
      vehicleEmissionType?: string;
      vulnerabilities?: string[];
    };
    const currentAqi = Number(body.currentAqi ?? 45);
    const hourlyForecast = Array.isArray(body.hourlyForecast)
      ? (body.hourlyForecast as Array<{ localHourLabel?: string; usAqi?: number; status?: string }>).slice(
          0,
          24
        )
      : [];
    const apiKey = getBrowserMapsApiKey();
    const homeLat = Number(homeLocation.lat);
    const homeLng = Number(homeLocation.lng);

    const validVehicles = new Set<VehicleEmissionType>([
      'GASOLINE',
      'DIESEL',
      'HYBRID',
      'ELECTRIC',
    ]);
    const vehicleEmissionType: VehicleEmissionType = validVehicles.has(
      familyProfile.vehicleEmissionType as VehicleEmissionType
    )
      ? (familyProfile.vehicleEmissionType as VehicleEmissionType)
      : 'GASOLINE';

    async function resolvePlace(
      query: string,
      biasLat: number,
      biasLng: number
    ): Promise<VerifiedPlaceRef | null> {
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
        },
        body: JSON.stringify({
          textQuery: query,
          pageSize: 1,
          languageCode: 'en',
          locationBias: {
            circle: { center: { latitude: biasLat, longitude: biasLng }, radius: 15000.0 },
          },
        }),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { places?: GooglePlacesApiItem[] };
      const p = data.places?.[0];
      if (!p?.location?.latitude || !p?.location?.longitude) return null;
      return {
        name: p.displayName?.text || query,
        address: p.formattedAddress || '',
        lat: p.location.latitude,
        lng: p.location.longitude,
        googleMapsUri: p.googleMapsUri || '',
        placeType: p.primaryTypeDisplayName?.text || '',
      };
    }

    async function computeRoute(
      origLat: number,
      origLng: number,
      destLat: number,
      destLng: number,
      travelMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK'
    ): Promise<ComputedRouteMetrics | null> {
      const reqBody: Record<string, unknown> = {
        origin: { location: { latLng: { latitude: origLat, longitude: origLng } } },
        destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
        travelMode,
      };
      let fieldMask = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';
      if (travelMode === 'DRIVE') {
        reqBody.routingPreference = 'TRAFFIC_AWARE_OPTIMAL';
        reqBody.extraComputations = ['FUEL_CONSUMPTION'];
        reqBody.routeModifiers = { vehicleInfo: { emissionType: vehicleEmissionType } };
        reqBody.requestedReferenceRoutes = ['FUEL_EFFICIENT'];
        fieldMask += ',routes.routeLabels,routes.travelAdvisory.fuelConsumptionMicroliters';
      }
      const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(reqBody),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { routes?: GoogleRoutesApiItem[] };
      const routes = data.routes || [];
      if (routes.length === 0) return null;
      const defaultRoute =
        routes.find((r) => r.routeLabels?.includes('DEFAULT_ROUTE')) || routes[0];
      const ecoRoute =
        routes.find((r) => r.routeLabels?.includes('FUEL_EFFICIENT')) || defaultRoute;
      return {
        mode: travelMode,
        distanceMeters: Number(defaultRoute.distanceMeters || 0),
        durationSeconds: parseDurationSeconds(defaultRoute.duration),
        encodedPolyline: defaultRoute.polyline?.encodedPolyline || '',
        fuelMicroliters: Number(defaultRoute.travelAdvisory?.fuelConsumptionMicroliters || 0),
        ecoDistanceMeters: Number(ecoRoute.distanceMeters || defaultRoute.distanceMeters || 0),
        ecoDurationSeconds: parseDurationSeconds(ecoRoute.duration || defaultRoute.duration),
        ecoFuelMicroliters: Number(ecoRoute.travelAdvisory?.fuelConsumptionMicroliters || 0),
        ecoPolyline:
          ecoRoute.polyline?.encodedPolyline || defaultRoute.polyline?.encodedPolyline || '',
      };
    }

    const enrichedLegs = await Promise.all(
      schedule.map(async (item, idx) => {
        let destPlace: VerifiedPlaceRef | null =
          Number.isFinite(Number(item.destinationLat)) &&
          Number.isFinite(Number(item.destinationLng))
            ? {
                name: String(item.destinationQuery || item.title),
                address: String(item.destinationQuery || ''),
                lat: Number(item.destinationLat),
                lng: Number(item.destinationLng),
                googleMapsUri: '',
                placeType: '',
              }
            : await resolvePlace(String(item.destinationQuery || item.title), homeLat, homeLng);

        if (!destPlace) {
          destPlace = await resolvePlace(
            `${item.title} near ${homeLocation.label}`,
            homeLat,
            homeLng
          );
        }
        if (!destPlace) return null;

        const currentMode = item.currentMode || 'DRIVE';
        const [driveRoute, transitRoute, bikeRoute, walkRoute, nearbyTransitOrPark] =
          await Promise.all([
            computeRoute(homeLat, homeLng, destPlace.lat, destPlace.lng, 'DRIVE'),
            computeRoute(homeLat, homeLng, destPlace.lat, destPlace.lng, 'TRANSIT'),
            computeRoute(homeLat, homeLng, destPlace.lat, destPlace.lng, 'BICYCLE'),
            computeRoute(homeLat, homeLng, destPlace.lat, destPlace.lng, 'WALK'),
            resolvePlace(
              currentMode === 'DRIVE' ? 'transit station' : 'public park greenway',
              (homeLat + destPlace.lat) / 2,
              (homeLng + destPlace.lng) / 2
            ),
          ]);

        return computeCommuteLegImpact({
          item,
          idx,
          destPlace,
          vehicleEmissionType,
          currentAqi,
          driveRoute,
          transitRoute,
          bikeRoute,
          walkRoute,
          nearbyTransitOrPark,
        });
      })
    );

    const validLegs = enrichedLegs.filter((l): l is NonNullable<typeof l> => l !== null);
    if (validLegs.length === 0) {
      throw new Error('Could not resolve destinations via Google Places API.');
    }

    let aiParsed: GeminiRoutineAdvicePayload = {};
    try {
      const ai = getBrowserGeminiClient();
      const geminiPrompt = buildRoutinePlanPrompt({
        validLegs,
        vulnerabilities: familyProfile.vulnerabilities,
        hourlyForecast,
        currentAqi,
      });

      const aiRes = await generateContentWithModelFallback(
        ai,
        ['gemini-4-hydrogen', 'gemini-3.5-flash-lite'],
        {
          contents: geminiPrompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                planTitle: { type: Type.STRING },
                legAdvice: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      recommendedTimeWindow: { type: Type.STRING },
                      swapHeadline: { type: Type.STRING },
                      swapRationale: { type: Type.STRING },
                    },
                    required: ['id', 'recommendedTimeWindow', 'swapHeadline', 'swapRationale'],
                  },
                },
              },
              required: ['planTitle', 'legAdvice'],
            },
          },
        }
      );
      aiParsed = JSON.parse((aiRes.text ?? '{}').trim() || '{}') as GeminiRoutineAdvicePayload;
    } catch {
      aiParsed = {};
    }

    return mergeSwapsWithGeminiAdvice(
      validLegs,
      aiParsed,
      String(homeLocation.label || 'Home')
    ) as unknown as T;
  }

  throw new Error(`Unsupported API endpoint: ${url}`);
}
