import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import type { ScheduleItemInput, VehicleEmissionType, VerifiedPlaceRef } from './src/types';
import {
  ALLOWED_TILE_TYPES,
  buildAirQualityOverviewFromRaw,
  buildRoomScanPrompt,
  buildRoutinePlanPrompt,
  computeCommuteLegImpact,
  extractApiErrorMessage,
  getErrorMessage,
  GMP_SOLUTION_ID,
  isGeminiKeyError,
  isQuotaError,
  mergeSwapsWithGeminiAdvice,
  parseDurationSeconds,
  sanitizeRoomScanResponse,
  type ComputedRouteMetrics,
  type GeminiRoutineAdvicePayload,
  type GoogleWeatherHourlyPayload,
  type GoogleWeatherHourSlotPayload,
  type OpenMeteoResponsePayload,
} from './src/lib/airQualityDomain';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

function getMapsApiKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Lightweight in-memory sliding-window rate limiter per client IP for API routes.
 */
function createApiRateLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const existing = hits.get(clientIp);

    if (!existing || now > existing.resetAt) {
      hits.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait a moment before making more requests.',
        quotaExceeded: true,
      });
      return;
    }
    next();
  };
}

/**
 * Sets defensive HTTP security headers on all server responses.
 */
function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
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

async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: '12mb' }));
  app.use('/api', createApiRateLimiter());

  // 1. Public runtime config (never exposes GEMINI_API_KEY)
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      mapsApiKey: getMapsApiKey(),
    });
  });

  // 2. Live 500m Hyper-Local Air Quality (Open-Meteo CAMS) + Google Weather API + Safe Ventilation Window Timeline
  app.post('/api/air-quality/overview', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        lat?: unknown;
        lng?: unknown;
        vulnerabilities?: unknown;
      };
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const vulnerabilities: string[] = Array.isArray(body.vulnerabilities)
        ? body.vulnerabilities.map(String)
        : [];

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        return res
          .status(400)
          .json({ error: 'Valid latitude and longitude coordinates are required.' });
      }

      const apiKey = getMapsApiKey();
      const weatherHeaders = {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
      };

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
        fetch(openMeteoUrl.toString(), { method: 'GET' }),
        apiKey
          ? fetch(weatherCurrentUrl.toString(), { method: 'GET', headers: weatherHeaders })
          : Promise.resolve(null),
        apiKey
          ? fetch(weatherHourlyUrl.toString(), { method: 'GET', headers: weatherHeaders })
          : Promise.resolve(null),
      ]);

      const omText = await omRes.text();
      if (!omRes.ok) {
        const readable = extractApiErrorMessage(omText, `HTTP ${omRes.status}`);
        return res.status(omRes.status === 429 ? 429 : 502).json({
          error: `Open-Meteo Air Quality API error (${omRes.status}): ${readable}`,
        });
      }
      const omData = JSON.parse(omText) as OpenMeteoResponsePayload;

      let weatherCurr: GoogleWeatherHourSlotPayload | null = null;
      if (weatherCurrRes) {
        const weatherCurrText = await weatherCurrRes.text();
        if (!weatherCurrRes.ok && isQuotaError(weatherCurrRes.status, weatherCurrText)) {
          return res.status(429).json({ error: 'Weather API quota reached.', quotaExceeded: true });
        }
        if (weatherCurrRes.ok) {
          weatherCurr = JSON.parse(weatherCurrText) as GoogleWeatherHourSlotPayload;
        }
      }

      let weatherHourly: GoogleWeatherHourlyPayload = { forecastHours: [] };
      if (weatherHourlyRes && weatherHourlyRes.ok) {
        weatherHourly = JSON.parse(await weatherHourlyRes.text()) as GoogleWeatherHourlyPayload;
      }

      const overview = buildAirQualityOverviewFromRaw({
        lat,
        lng,
        vulnerabilities,
        openMeteoData: omData,
        weatherCurr,
        weatherHourly,
      });

      return res.json(overview);
    } catch (err: unknown) {
      console.error('Air Quality overview error:', err);
      return res
        .status(500)
        .json({ error: getErrorMessage(err, 'Failed to fetch air quality data.') });
    }
  });

  // 3. Air Quality Heatmap Tile Proxy (sends attribution header & keeps key server-side)
  app.get('/api/air-quality/tile/:mapType/:z/:x/:y', async (req: Request, res: Response) => {
    try {
      const { mapType, z, x, y } = req.params;
      if (!ALLOWED_TILE_TYPES.has(mapType)) {
        return res.status(400).send('Invalid heatmap type');
      }
      const zi = Number(z);
      const xi = Number(x);
      const yi = Number(y);
      const maxTile = 1 << zi;
      if (
        !Number.isInteger(zi) ||
        zi < 0 ||
        zi > 16 ||
        !Number.isInteger(xi) ||
        !Number.isInteger(yi) ||
        xi < 0 ||
        xi >= maxTile ||
        yi < 0 ||
        yi >= maxTile
      ) {
        return res.status(400).send('Invalid tile coordinates');
      }

      const apiKey = getMapsApiKey();
      if (!apiKey) return res.status(503).send('Maps key missing');

      const tileUrl = `https://airquality.googleapis.com/v1/mapTypes/${encodeURIComponent(mapType)}/heatmapTiles/${zi}/${xi}/${yi}?key=${encodeURIComponent(apiKey)}`;
      const tileRes = await fetch(tileUrl, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
        },
      });

      if (!tileRes.ok) {
        return res.status(tileRes.status).end();
      }

      const buf = Buffer.from(await tileRes.arrayBuffer());
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.send(buf);
    } catch {
      return res.status(500).end();
    }
  });

  // 4. Places API (New) Text Search Proxy
  app.post('/api/places/search', async (req: Request, res: Response) => {
    try {
      const reqBody = (req.body || {}) as {
        query?: unknown;
        lat?: unknown;
        lng?: unknown;
        radiusMeters?: unknown;
      };
      const query = String(reqBody.query || '').trim();
      const lat = Number(reqBody.lat);
      const lng = Number(reqBody.lng);
      const radiusMeters = Math.min(50000, Math.max(500, Number(reqBody.radiusMeters || 8000)));

      if (!query || query.length > 200) {
        return res.status(400).json({ error: 'Search query must be 1-200 characters.' });
      }
      const apiKey = getMapsApiKey();
      if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured.' });

      const body: Record<string, unknown> = {
        textQuery: query,
        pageSize: 5,
        languageCode: 'en',
      };
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        body.locationBias = {
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
          'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
        },
        body: JSON.stringify(body),
      });

      const text = await placeRes.text();
      if (!placeRes.ok) {
        const readable = extractApiErrorMessage(text, `HTTP ${placeRes.status}`);
        const clientStatus =
          placeRes.status === 429 ? 429 : placeRes.status === 403 ? 424 : placeRes.status;
        return res.status(clientStatus).json({
          error: `Places API error (${placeRes.status}): ${readable}`,
          upstreamStatus: placeRes.status,
          quotaExceeded: isQuotaError(placeRes.status, text),
        });
      }

      const parsed = JSON.parse(text) as { places?: GooglePlacesApiItem[] };
      const places = (parsed.places || []).map((p) => ({
        id: p.id,
        name: p.displayName?.text || query,
        address: p.formattedAddress || '',
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        googleMapsUri: p.googleMapsUri || '',
        placeType: p.primaryTypeDisplayName?.text || '',
      }));

      return res.json({ places });
    } catch (err: unknown) {
      return res.status(500).json({ error: getErrorMessage(err, 'Places search failed.') });
    }
  });

  // 5. Snap-a-Room IAQ Scanner (Gemini Vision gemini-4-hydrogen)
  app.post('/api/iaq/scan', async (req: Request, res: Response) => {
    try {
      const reqBody = (req.body || {}) as {
        imageBase64?: unknown;
        mimeType?: unknown;
        roomType?: unknown;
        outdoorAqi?: unknown;
        dominantPollutant?: unknown;
        familyProfile?: Record<string, unknown>;
      };
      const imageBase64 = String(reqBody.imageBase64 || '');
      const mimeType = String(reqBody.mimeType || 'image/jpeg');
      const roomType = String(reqBody.roomType || 'KITCHEN');
      const outdoorAqi = Number(reqBody.outdoorAqi ?? 40);
      const dominantPollutant = String(reqBody.dominantPollutant || 'PM2.5');
      const familyProfile = reqBody.familyProfile || {};

      if (!imageBase64 || imageBase64.length < 100) {
        return res.status(400).json({ error: 'Please upload or select a room photo to scan.' });
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        return res
          .status(400)
          .json({ error: 'Unsupported image format. Please use JPEG, PNG, or WebP.' });
      }

      const ai = getGeminiClient();
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

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              roomSummary: {
                type: Type.STRING,
                description:
                  '2-sentence objective summary of what is visible in the room affecting air quality (max 450 chars).',
              },
              overallRiskLevel: {
                type: Type.STRING,
                enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'],
              },
              ventilationAdvice: {
                type: Type.STRING,
                description:
                  'Specific window/exhaust action combining room layout and live outdoor AQI (max 450 chars).',
              },
              detectedRisks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING, description: 'Specific visible source in photo.' },
                    pollutantType: { type: Type.STRING, description: 'e.g. NO2 & Ultrafine PM2.5' },
                    severity: {
                      type: Type.STRING,
                      enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'],
                    },
                    explanation: {
                      type: Type.STRING,
                      description: '1-2 sentence explanation tailored to household.',
                    },
                  },
                  required: ['source', 'pollutantType', 'severity', 'explanation'],
                },
              },
              hacks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: {
                      type: Type.STRING,
                      description: 'Unique short id like hack-1, hack-2, hack-3',
                    },
                    title: { type: Type.STRING, description: 'Clear action-oriented title' },
                    costTier: {
                      type: Type.STRING,
                      enum: ['Zero Cost', 'Under $15', 'Under $40'],
                    },
                    estimatedImpact: {
                      type: Type.STRING,
                      description: 'Quantified expected IAQ gain, e.g. Up to 50% lower peak NO2',
                    },
                    steps: { type: Type.STRING, description: 'Clear 1-2 sentence how-to instruction.' },
                    whyItWorks: {
                      type: Type.STRING,
                      description: 'Brief building-science rationale.',
                    },
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
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        return res.status(502).json({ error: 'Gemini returned an empty room analysis.' });
      }
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      const result = sanitizeRoomScanResponse(parsed, roomType, outdoorAqi);

      return res.json(result);
    } catch (err: unknown) {
      const readable = extractApiErrorMessage(
        getErrorMessage(err, ''),
        'Room air quality analysis failed.'
      );
      const keyErr = isGeminiKeyError(err, readable);
      const errStatus =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: unknown }).status)
          : 0;
      const status = errStatus === 429 ? 429 : keyErr ? 424 : 500;
      console.warn('IAQ scan failed:', readable);
      return res.status(status).json({
        error: keyErr
          ? `Gemini API key was rejected (${readable}). Please check or select a valid Gemini API key in Settings > Secrets.`
          : readable,
      });
    }
  });

  // 6. Daily Routine & Impact Planner (Google Maps Routes API + Places API + Gemini)
  app.post('/api/routine/plan', async (req: Request, res: Response) => {
    try {
      const reqBody = (req.body || {}) as {
        homeLocation?: { label?: string; lat?: number; lng?: number };
        schedule?: Array<Partial<ScheduleItemInput>>;
        familyProfile?: {
          vehicleEmissionType?: string;
          vulnerabilities?: string[];
        };
        currentAqi?: unknown;
        hourlyForecast?: Array<{ localHourLabel?: string; usAqi?: number; status?: string }>;
      };

      const homeLocation = reqBody.homeLocation;
      const schedule = Array.isArray(reqBody.schedule) ? reqBody.schedule.slice(0, 6) : [];
      const familyProfile = reqBody.familyProfile || {};
      const currentAqi = Number(reqBody.currentAqi ?? 45);
      const hourlyForecast = Array.isArray(reqBody.hourlyForecast)
        ? reqBody.hourlyForecast.slice(0, 24)
        : [];

      if (
        !homeLocation ||
        !Number.isFinite(Number(homeLocation.lat)) ||
        !Number.isFinite(Number(homeLocation.lng))
      ) {
        return res.status(400).json({ error: 'Valid home location coordinates are required.' });
      }
      if (schedule.length === 0) {
        return res
          .status(400)
          .json({ error: 'Add at least one daily routine stop to generate swaps.' });
      }

      const apiKey = getMapsApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'Google Maps Platform API key is not configured.' });
      }

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
            'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
          },
          body: JSON.stringify({
            textQuery: query,
            pageSize: 1,
            languageCode: 'en',
            locationBias: {
              circle: {
                center: { latitude: biasLat, longitude: biasLng },
                radius: 15000.0,
              },
            },
          }),
        });
        const txt = await resp.text();
        if (!resp.ok) {
          if (isQuotaError(resp.status, txt)) {
            throw Object.assign(new Error('Google Maps Places API quota reached.'), {
              quotaExceeded: true,
              status: 429,
            });
          }
          return null;
        }
        const data = JSON.parse(txt) as { places?: GooglePlacesApiItem[] };
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
        const body: Record<string, unknown> = {
          origin: { location: { latLng: { latitude: origLat, longitude: origLng } } },
          destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
          travelMode,
        };

        let fieldMask = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';

        if (travelMode === 'DRIVE') {
          body.routingPreference = 'TRAFFIC_AWARE_OPTIMAL';
          body.extraComputations = ['FUEL_CONSUMPTION'];
          body.routeModifiers = { vehicleInfo: { emissionType: vehicleEmissionType } };
          body.requestedReferenceRoutes = ['FUEL_EFFICIENT'];
          fieldMask += ',routes.routeLabels,routes.travelAdvisory.fuelConsumptionMicroliters';
        }

        const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': fieldMask,
            'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
          },
          body: JSON.stringify(body),
        });
        const txt = await resp.text();
        if (!resp.ok) {
          if (isQuotaError(resp.status, txt)) {
            throw Object.assign(new Error('Google Maps Routes API quota reached.'), {
              quotaExceeded: true,
              status: 429,
            });
          }
          return null;
        }
        const data = JSON.parse(txt) as { routes?: GoogleRoutesApiItem[] };
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
          ecoDistanceMeters: Number(
            ecoRoute.distanceMeters || defaultRoute.distanceMeters || 0
          ),
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
              : await resolvePlace(
                  String(item.destinationQuery || item.title),
                  homeLat,
                  homeLng
                );

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
        return res.status(400).json({
          error:
            'Could not resolve destinations via Google Places API. Try more specific place names.',
        });
      }

      const ai = getGeminiClient();
      const geminiPrompt = buildRoutinePlanPrompt({
        validLegs,
        vulnerabilities: familyProfile.vulnerabilities,
        hourlyForecast,
        currentAqi,
      });

      const aiRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: geminiPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              planTitle: {
                type: Type.STRING,
                description: 'Concise daily plan headline (max 80 chars).',
              },
              legAdvice: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    recommendedTimeWindow: {
                      type: Type.STRING,
                      description: 'e.g. Leave at 7:45 AM (low PM2.5)',
                    },
                    swapHeadline: { type: Type.STRING, description: 'Punchy 1-line swap action' },
                    swapRationale: {
                      type: Type.STRING,
                      description: '1-2 concise sentences citing real route/stop benefit',
                    },
                  },
                  required: ['id', 'recommendedTimeWindow', 'swapHeadline', 'swapRationale'],
                },
              },
            },
            required: ['planTitle', 'legAdvice'],
          },
        },
      });

      const aiParsed = JSON.parse(
        (aiRes.text ?? '{}').trim() || '{}'
      ) as GeminiRoutineAdvicePayload;
      const planResult = mergeSwapsWithGeminiAdvice(
        validLegs,
        aiParsed,
        String(homeLocation.label || 'Home')
      );

      return res.json(planResult);
    } catch (err: unknown) {
      const readable = extractApiErrorMessage(
        getErrorMessage(err, ''),
        'Failed to compute clean-air routine swaps.'
      );
      const keyErr = isGeminiKeyError(err, readable);
      const errObj =
        typeof err === 'object' && err !== null
          ? (err as { status?: number; quotaExceeded?: boolean })
          : {};
      const status = errObj.status === 429 || errObj.quotaExceeded ? 429 : keyErr ? 424 : 500;
      console.warn('Routine plan failed:', readable);
      return res.status(status).json({
        error: keyErr
          ? `Gemini API key was rejected (${readable}). Please check or select a valid Gemini API key in Settings > Secrets.`
          : readable,
        quotaExceeded: Boolean(errObj.quotaExceeded || status === 429),
      });
    }
  });

  // Frontend Vite middleware (dev) or static dist serving (prod)
  if (process.env.NODE_ENV !== 'production') {
    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(`
const sheetsMap = new Map();
if (typeof document !== 'undefined') {
  document.querySelectorAll('style[data-vite-dev-id]').forEach((el) => {
    sheetsMap.set(el.getAttribute('data-vite-dev-id'), el);
  });
}
export function updateStyle(id, content) {
  if (typeof document === 'undefined') return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay extends HTMLElement {
  close() {
    this.remove();
  }
}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BreatheClear server running on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start BreatheClear server:', err);
  process.exit(1);
});
