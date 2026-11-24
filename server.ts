import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const GMP_SOLUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';
const ALLOWED_TILE_TYPES = new Set([
  'US_AQI',
  'PM25_INDIGO_PERSIAN',
  'UAQI_RED_GREEN',
  'UAQI_INDIGO_PERSIAN',
]);

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

function isQuotaError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  return bodyText.includes('RESOURCE_EXHAUSTED') || bodyText.includes('OVER_QUERY_LIMIT');
}

function formatPollutantName(code: string): string {
  const names: Record<string, string> = {
    pm25: 'PM2.5',
    pm10: 'PM10',
    o3: 'Ozone (O₃)',
    no2: 'Nitrogen Dioxide (NO₂)',
    co: 'Carbon Monoxide (CO)',
    so2: 'Sulfur Dioxide (SO₂)',
  };
  return names[code.toLowerCase()] || code.toUpperCase();
}

function formatUnit(unit?: string): string {
  if (!unit) return '';
  if (unit === 'MICROGRAMS_PER_CUBIC_METER') return 'µg/m³';
  if (unit === 'PARTS_PER_BILLION') return 'ppb';
  if (unit === 'PARTS_PER_MILLION') return 'ppm';
  return unit;
}

function parseDurationSeconds(dur?: string): number {
  if (!dur) return 0;
  const match = dur.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(Number(match[1])) : 0;
}

function formatHourShort(isoString: string, timeZone?: string): string {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: true,
      timeZone: timeZone || undefined,
    }).format(d);
  } catch {
    return isoString.slice(11, 16);
  }
}

function extractApiErrorMessage(raw: string, fallback: string): string {
  try {
    const jsonStart = raw.indexOf('{');
    const candidate = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
    const parsed = JSON.parse(candidate);
    const msg = parsed?.error?.message || parsed?.message;
    const reason = parsed?.error?.details?.[0]?.reason;
    if (msg && reason) return `${msg} (${reason})`;
    if (msg) return String(msg);
  } catch {
    // Plain text error
  }
  return raw ? raw.slice(0, 220) : fallback;
}

function isGeminiKeyError(err: any, readable: string): boolean {
  const status = Number(err?.status || err?.code || 0);
  return (
    status === 401 ||
    readable.includes('API_KEY_INVALID') ||
    readable.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
    readable.includes('API key not valid')
  );
}

function getUsAqiCategory(usAqi: number): string {
  if (usAqi <= 50) return 'Good air quality';
  if (usAqi <= 100) return 'Moderate air quality';
  if (usAqi <= 150) return 'Unhealthy for sensitive groups';
  if (usAqi <= 200) return 'Unhealthy air quality';
  if (usAqi <= 300) return 'Very unhealthy air quality';
  return 'Hazardous air quality';
}

function buildHealthRecommendations(usAqi: number, dominantLabel: string): Record<string, string> {
  if (usAqi <= 50) {
    return {
      generalPopulation: `Air quality is clean (US AQI ${usAqi}). Ideal conditions for outdoor exercise and full cross-ventilation.`,
      lungDiseasePopulation: `Low ${dominantLabel} levels make outdoor activity comfortable. Keep rescue medication handy as routine precaution.`,
      children: `Safe for outdoor play, school sports, and opening bedroom windows for fresh air.`,
      elderly: `Clean ambient air is well suited for walks and natural home ventilation.`,
      pregnantWomen: `Outdoor particulate and gas levels are low — normal outdoor routines are safe.`,
      heartDiseasePopulation: `Low pollution load today — safe for light-to-moderate outdoor activity.`,
      athletes: `Great conditions for high-intensity outdoor running or cycling.`,
    };
  }
  if (usAqi <= 100) {
    return {
      generalPopulation: `Air quality is acceptable (US AQI ${usAqi}), though ${dominantLabel} is moderately elevated along busy corridors.`,
      lungDiseasePopulation: `Elevated ${dominantLabel} may irritate sensitive airways — prefer off-arterial routes and keep HEPA filtration ready.`,
      children: `Outdoor play is generally fine; shorten strenuous outdoor sports near heavy traffic.`,
      elderly: `Consider shorter outdoor errands during lower-AQI morning or evening windows.`,
      pregnantWomen: `Limit prolonged exposure near idling traffic; use brief window purges during cleaner hours.`,
      heartDiseasePopulation: `Moderate ${dominantLabel} — pace prolonged exertion and avoid congested roadways.`,
      athletes: `Shift intense outdoor training to greenways or the cleanest forecast window.`,
    };
  }
  if (usAqi <= 150) {
    return {
      generalPopulation: `${dominantLabel} is elevated (US AQI ${usAqi}). Sensitive households should reduce prolonged outdoor exertion.`,
      lungDiseasePopulation: `Keep windows closed, run indoor HEPA filtration, and avoid outdoor exercise until AQI drops below 50.`,
      children: `Move active play indoors and limit time near busy streets while ${dominantLabel} remains high.`,
      elderly: `Stay indoors with filtered air and postpone non-essential outdoor errands.`,
      pregnantWomen: `Keep windows sealed and wear a well-fitted N95/KF94 mask if commuting outdoors.`,
      heartDiseasePopulation: `Avoid strenuous outdoor activity and keep indoor air recirculating through filtration.`,
      athletes: `Move workouts indoors or reschedule to a lower-AQI window.`,
    };
  }
  return {
    generalPopulation: `Unhealthy ${dominantLabel} levels (US AQI ${usAqi}). Keep windows sealed and limit outdoor exposure for everyone.`,
    lungDiseasePopulation: `High respiratory risk — remain indoors with continuous HEPA filtration and follow your asthma/COPD action plan.`,
    children: `Keep children indoors with windows closed and air purifiers on medium-high.`,
    elderly: `Avoid outdoor exertion completely and run indoor air filtration continuously.`,
    pregnantWomen: `Stay indoors with filtered air; use an N95 mask for unavoidable trips outside.`,
    heartDiseasePopulation: `Avoid all outdoor exertion and monitor for chest tightness or shortness of breath.`,
    athletes: `Cancel outdoor training and exercise indoors in filtered air.`,
  };
}

const POLLUTANT_META: Record<
  string,
  { displayName: string; fullName: string; sources: string; effects: string }
> = {
  pm25: {
    displayName: 'PM2.5',
    fullName: 'Fine Particulate Matter (<2.5 µm)',
    sources: 'Vehicle exhaust, brake/tire wear, urban combustion, wildfire smoke, and cooking aerosols.',
    effects: 'Penetrates deep into lungs and bloodstream; aggravates asthma, heart conditions, and airway inflammation.',
  },
  pm10: {
    displayName: 'PM10',
    fullName: 'Coarse Particulate Matter (<10 µm)',
    sources: 'Road dust, construction activity, pollen fragments, and industrial emissions.',
    effects: 'Irritates eyes, nose, throat, and upper respiratory tract, especially in children and older adults.',
  },
  o3: {
    displayName: 'O₃',
    fullName: 'Ground-Level Ozone',
    sources: 'Formed when sunlight reacts with vehicle NOₓ and volatile organic compounds (VOCs) on warm afternoons.',
    effects: 'Triggers airway constriction, coughing, and reduced lung function during outdoor exertion.',
  },
  no2: {
    displayName: 'NO₂',
    fullName: 'Nitrogen Dioxide',
    sources: 'Diesel and gasoline traffic corridors, power generation, and unvented indoor gas stoves.',
    effects: 'Inflames bronchial lining and increases asthma flare-ups and respiratory infections in kids.',
  },
  so2: {
    displayName: 'SO₂',
    fullName: 'Sulfur Dioxide',
    sources: 'Shipping fuel, industrial boilers, and fossil-fuel combustion.',
    effects: 'Can rapidly tighten airways in people with asthma even during brief outdoor exposure.',
  },
  co: {
    displayName: 'CO',
    fullName: 'Carbon Monoxide',
    sources: 'Incomplete fuel combustion from congested traffic, garages, and poorly vented gas appliances.',
    effects: 'Reduces oxygen delivery in the bloodstream, causing fatigue and cardiovascular strain.',
  },
};

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  // 1. Public runtime config (never exposes GEMINI_API_KEY)
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      mapsApiKey: getMapsApiKey(),
    });
  });

  // 2. Live 500m Hyper-Local Air Quality (Open-Meteo CAMS) + Google Weather API + Safe Ventilation Window Timeline
  app.post('/api/air-quality/overview', async (req: Request, res: Response) => {
    try {
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const vulnerabilities: string[] = Array.isArray(req.body?.vulnerabilities)
        ? req.body.vulnerabilities
        : [];

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Valid latitude and longitude coordinates are required.' });
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

      const weatherCurrentUrl = new URL('https://weather.googleapis.com/v1/currentConditions:lookup');
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
      const omData = JSON.parse(omText);
      const curr = omData.current || {};

      let weatherCurr: any = null;
      if (weatherCurrRes) {
        const weatherCurrText = await weatherCurrRes.text();
        if (!weatherCurrRes.ok && isQuotaError(weatherCurrRes.status, weatherCurrText)) {
          return res.status(429).json({ error: 'Weather API quota reached.', quotaExceeded: true });
        }
        if (weatherCurrRes.ok) weatherCurr = JSON.parse(weatherCurrText);
      }

      let weatherHourly: any = { forecastHours: [] };
      if (weatherHourlyRes && weatherHourlyRes.ok) {
        weatherHourly = JSON.parse(await weatherHourlyRes.text());
      }

      const timeZoneId: string | undefined = weatherCurr?.timeZone?.id || weatherHourly?.timeZone?.id;

      const usAqi = Math.max(0, Math.round(Number(curr.us_aqi ?? 25)));
      const uaqi = Math.max(0, Math.min(100, Math.round(100 - usAqi * 0.48)));
      const category = getUsAqiCategory(usAqi);

      // Determine exact dominant pollutant from Open-Meteo EPA sub-indexes
      const subIndexes: Array<{ code: string; subAqi: number }> = [
        { code: 'pm25', subAqi: Number(curr.us_aqi_pm2_5 ?? 0) },
        { code: 'pm10', subAqi: Number(curr.us_aqi_pm10 ?? 0) },
        { code: 'o3', subAqi: Number(curr.us_aqi_ozone ?? 0) },
        { code: 'no2', subAqi: Number(curr.us_aqi_nitrogen_dioxide ?? 0) },
        { code: 'so2', subAqi: Number(curr.us_aqi_sulphur_dioxide ?? 0) },
        { code: 'co', subAqi: Number(curr.us_aqi_carbon_monoxide ?? 0) },
      ];
      subIndexes.sort((a, b) => b.subAqi - a.subAqi);
      const dominantCode = subIndexes[0]?.subAqi > 0 ? subIndexes[0].code : 'pm25';

      const rawConcentrations: Array<{ code: string; value: number | null }> = [
        { code: 'pm25', value: typeof curr.pm2_5 === 'number' ? curr.pm2_5 : null },
        { code: 'pm10', value: typeof curr.pm10 === 'number' ? curr.pm10 : null },
        { code: 'o3', value: typeof curr.ozone === 'number' ? curr.ozone : null },
        { code: 'no2', value: typeof curr.nitrogen_dioxide === 'number' ? curr.nitrogen_dioxide : null },
        { code: 'so2', value: typeof curr.sulphur_dioxide === 'number' ? curr.sulphur_dioxide : null },
        { code: 'co', value: typeof curr.carbon_monoxide === 'number' ? curr.carbon_monoxide : null },
      ];

      const pollutants = rawConcentrations
        .filter((item): item is { code: string; value: number } => item.value !== null)
        .map((item) => {
          const meta = POLLUTANT_META[item.code];
          return {
            code: item.code,
            displayName: meta?.displayName || formatPollutantName(item.code),
            fullName: meta?.fullName || formatPollutantName(item.code),
            value: Math.round(item.value * 10) / 10,
            units: 'µg/m³',
            sources: meta?.sources,
            effects: meta?.effects,
          };
        });

      const domPollutantObj = pollutants.find((p) => p.code === dominantCode);
      const dominantConcentration = domPollutantObj
        ? `${domPollutantObj.value.toFixed(1)} ${domPollutantObj.units}`
        : 'Measured live';

      // Sensitivity threshold calibration for Safe Ventilation Window
      const hasHighVulnerability = vulnerabilities.some((v) =>
        ['ASTHMA_COPD', 'YOUNG_CHILDREN', 'SENIORS_65', 'PREGNANCY', 'CARDIOVASCULAR'].includes(v)
      );
      const safeThresholdAqi = hasHighVulnerability ? 45 : 65;
      const moderateThresholdAqi = hasHighVulnerability ? 75 : 100;

      // Index Google Weather hourly forecast by UTC hour prefix (YYYY-MM-DDTHH)
      const weatherByHour: Record<string, any> = {};
      for (const wh of weatherHourly?.forecastHours || []) {
        const key = typeof wh?.interval?.startTime === 'string' ? wh.interval.startTime.slice(0, 13) : '';
        if (key) weatherByHour[key] = wh;
      }

      // Slice next 24 hours from Open-Meteo hourly forecast starting at the current UTC hour
      const hourly = omData.hourly || {};
      const times: string[] = Array.isArray(hourly.time) ? hourly.time : [];
      const nowHourPrefix = new Date().toISOString().slice(0, 13);
      let startIdx = times.findIndex((t) => t.slice(0, 13) >= nowHourPrefix);
      if (startIdx < 0) startIdx = 0;

      const timeline = times.slice(startIdx, startIdx + 24).map((timeStr, offset) => {
        const idx = startIdx + offset;
        const isoUtc = `${timeStr}:00Z`;
        const hourKey = timeStr.slice(0, 13);

        const slotUsAqi = Math.max(0, Math.round(Number(hourly.us_aqi?.[idx] ?? usAqi)));
        const slotUaqi = Math.max(0, Math.min(100, Math.round(100 - slotUsAqi * 0.48)));

        const slotSubs = [
          { code: 'pm25', val: Number(hourly.us_aqi_pm2_5?.[idx] ?? 0) },
          { code: 'pm10', val: Number(hourly.us_aqi_pm10?.[idx] ?? 0) },
          { code: 'o3', val: Number(hourly.us_aqi_ozone?.[idx] ?? 0) },
          { code: 'no2', val: Number(hourly.us_aqi_nitrogen_dioxide?.[idx] ?? 0) },
        ].sort((a, b) => b.val - a.val);
        const slotDom = slotSubs[0]?.val > 0 ? slotSubs[0].code : dominantCode;

        const w = weatherByHour[hourKey];
        const tempC = typeof w?.temperature?.degrees === 'number' ? Math.round(w.temperature.degrees * 10) / 10 : null;
        const humidityPct = typeof w?.relativeHumidity === 'number' ? w.relativeHumidity : null;
        const windKph = typeof w?.wind?.speed?.value === 'number' ? Math.round(w.wind.speed.value) : null;
        const precipChancePct = typeof w?.precipitation?.probability?.percent === 'number' ? w.precipitation.probability.percent : null;
        const weatherText = w?.weatherCondition?.description?.text || null;

        let status: 'SAFE_OPEN' | 'BRIEF_PURGE' | 'KEEP_SEALED' = 'SAFE_OPEN';
        let reason = 'Clean outdoor air ideal for cross-ventilation.';

        if (slotUsAqi > moderateThresholdAqi) {
          status = 'KEEP_SEALED';
          reason = `${formatPollutantName(slotDom)} elevated (AQI ${slotUsAqi}) — keep windows closed and run filtration.`;
        } else if (precipChancePct !== null && precipChancePct >= 60) {
          status = 'BRIEF_PURGE';
          reason = `Rain likely (${precipChancePct}%) — crack sheltered windows briefly only.`;
        } else if (slotUsAqi > safeThresholdAqi) {
          status = 'BRIEF_PURGE';
          reason = hasHighVulnerability
            ? `AQI ${slotUsAqi} exceeds sensitive threshold (${safeThresholdAqi}) — limit to 10-min purge.`
            : `Moderate ${formatPollutantName(slotDom)} (AQI ${slotUsAqi}) — brief airing recommended.`;
        } else if (humidityPct !== null && humidityPct >= 82) {
          status = 'BRIEF_PURGE';
          reason = `Air is clean (AQI ${slotUsAqi}) but high humidity (${humidityPct}%) favors short 15-min airing.`;
        } else if (windKph !== null && windKph >= 8) {
          reason = `Low ${formatPollutantName(slotDom)} (AQI ${slotUsAqi}) with ${windKph} km/h breeze for rapid air exchange.`;
        } else {
          reason = `Clean air (AQI ${slotUsAqi}) — safe to open windows for natural circulation.`;
        }

        return {
          dateTime: isoUtc,
          localHourLabel: formatHourShort(isoUtc, timeZoneId),
          usAqi: slotUsAqi,
          uaqi: slotUaqi,
          category: getUsAqiCategory(slotUsAqi),
          dominantPollutant: formatPollutantName(slotDom),
          tempC,
          humidityPct,
          windKph,
          precipChancePct,
          weatherText,
          status,
          reason,
        };
      });

      // Find longest best continuous SAFE_OPEN window (tie-break by lowest avg AQI)
      let bestStart = -1;
      let bestEnd = -1;
      let bestAvg = 999;
      let curStart = -1;

      for (let i = 0; i <= timeline.length; i++) {
        const isSafe = i < timeline.length && timeline[i].status === 'SAFE_OPEN';
        if (isSafe && curStart === -1) {
          curStart = i;
        } else if (!isSafe && curStart !== -1) {
          const segLen = i - curStart;
          const bestLen = bestStart === -1 ? 0 : bestEnd - bestStart + 1;
          const segAvg =
            timeline.slice(curStart, i).reduce((acc, s) => acc + s.usAqi, 0) / segLen;
          if (segLen > bestLen || (segLen === bestLen && segAvg < bestAvg)) {
            bestStart = curStart;
            bestEnd = i - 1;
            bestAvg = segAvg;
          }
          curStart = -1;
        }
      }

      let bestVentilationWindow;
      if (bestStart !== -1) {
        const startLabel = timeline[bestStart].localHourLabel;
        const endLabel = timeline[bestEnd].localHourLabel;
        const hrs = bestEnd - bestStart + 1;
        bestVentilationWindow = {
          hasSafeWindow: true,
          label: hrs === 1 ? `${startLabel}` : `${startLabel} – ${endLabel}`,
          summary: `${hrs}h continuous low-pollution window (avg AQI ${Math.round(bestAvg)}) tailored to your household sensitivity.`,
          startHourLabel: startLabel,
          endHourLabel: endLabel,
          avgAqi: Math.round(bestAvg),
        };
      } else if (timeline.length > 0) {
        const cleanest = [...timeline].sort((a, b) => a.usAqi - b.usAqi)[0];
        bestVentilationWindow = {
          hasSafeWindow: false,
          label: `Brief purge at ${cleanest.localHourLabel}`,
          summary: `Outdoor AQI remains above your sensitive threshold (${safeThresholdAqi}) over the next 24h. Lowest reading is AQI ${cleanest.usAqi} around ${cleanest.localHourLabel}.`,
          startHourLabel: cleanest.localHourLabel,
          endHourLabel: cleanest.localHourLabel,
          avgAqi: cleanest.usAqi,
        };
      } else {
        bestVentilationWindow = {
          hasSafeWindow: usAqi <= safeThresholdAqi,
          label: usAqi <= safeThresholdAqi ? 'Safe to ventilate now' : 'Keep windows closed',
          summary: `Current AQI is ${usAqi}. Hourly forecast unavailable for this exact coordinate.`,
          startHourLabel: null,
          endHourLabel: null,
          avgAqi: usAqi,
        };
      }

      const dominantPollutantLabel = formatPollutantName(dominantCode);

      return res.json({
        fetchedAt: new Date().toISOString(),
        dataSource: 'open-meteo',
        lat,
        lng,
        usAqi,
        uaqi,
        category,
        dominantPollutant: dominantCode,
        dominantPollutantLabel,
        dominantConcentration,
        pollutants,
        healthRecommendations: buildHealthRecommendations(usAqi, dominantPollutantLabel),
        weather: {
          tempC: typeof weatherCurr?.temperature?.degrees === 'number' ? Math.round(weatherCurr.temperature.degrees * 10) / 10 : null,
          feelsLikeC: typeof weatherCurr?.feelsLikeTemperature?.degrees === 'number' ? Math.round(weatherCurr.feelsLikeTemperature.degrees * 10) / 10 : null,
          humidityPct: typeof weatherCurr?.relativeHumidity === 'number' ? weatherCurr.relativeHumidity : null,
          windKph: typeof weatherCurr?.wind?.speed?.value === 'number' ? Math.round(weatherCurr.wind.speed.value) : null,
          windDirection: weatherCurr?.wind?.direction?.cardinal?.replace(/_/g, ' ') || null,
          conditionText: weatherCurr?.weatherCondition?.description?.text || null,
          precipChancePct: typeof weatherCurr?.precipitation?.probability?.percent === 'number' ? weatherCurr.precipitation.probability.percent : null,
          uvIndex: typeof weatherCurr?.uvIndex === 'number' ? weatherCurr.uvIndex : null,
        },
        bestVentilationWindow,
        timeline,
        sensitivityThresholdAqi: safeThresholdAqi,
      });
    } catch (err: any) {
      console.error('Air Quality overview error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to fetch air quality data.' });
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
      if (!Number.isInteger(zi) || zi < 0 || zi > 16 || !Number.isInteger(xi) || !Number.isInteger(yi) || xi < 0 || xi >= maxTile || yi < 0 || yi >= maxTile) {
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

  // 4. Places API (New) Text Search Proxy (avoids CORS CF1)
  app.post('/api/places/search', async (req: Request, res: Response) => {
    try {
      const query = String(req.body?.query || '').trim();
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const radiusMeters = Math.min(50000, Math.max(500, Number(req.body?.radiusMeters || 8000)));

      if (!query || query.length > 200) {
        return res.status(400).json({ error: 'Search query must be 1-200 characters.' });
      }
      const apiKey = getMapsApiKey();
      if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured.' });

      const body: any = {
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
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
          'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
        },
        body: JSON.stringify(body),
      });

      const text = await placeRes.text();
      if (!placeRes.ok) {
        const readable = extractApiErrorMessage(text, `HTTP ${placeRes.status}`);
        const clientStatus = placeRes.status === 429 ? 429 : placeRes.status === 403 ? 424 : placeRes.status;
        return res.status(clientStatus).json({
          error: `Places API error (${placeRes.status}): ${readable}`,
          upstreamStatus: placeRes.status,
          quotaExceeded: isQuotaError(placeRes.status, text),
        });
      }

      const parsed = JSON.parse(text);
      const places = (parsed.places || []).map((p: any) => ({
        id: p.id,
        name: p.displayName?.text || query,
        address: p.formattedAddress || '',
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        googleMapsUri: p.googleMapsUri || '',
        placeType: p.primaryTypeDisplayName?.text || '',
      }));

      return res.json({ places });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Places search failed.' });
    }
  });

  // 5. Snap-a-Room IAQ Scanner (Gemini Vision gemini-4-hydrogen)
  app.post('/api/iaq/scan', async (req: Request, res: Response) => {
    try {
      const imageBase64 = String(req.body?.imageBase64 || '');
      const mimeType = String(req.body?.mimeType || 'image/jpeg');
      const roomType = String(req.body?.roomType || 'KITCHEN');
      const outdoorAqi = Number(req.body?.outdoorAqi ?? 40);
      const dominantPollutant = String(req.body?.dominantPollutant || 'PM2.5');
      const familyProfile = req.body?.familyProfile || {};

      if (!imageBase64 || imageBase64.length < 100) {
        return res.status(400).json({ error: 'Please upload or select a room photo to scan.' });
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        return res.status(400).json({ error: 'Unsupported image format. Please use JPEG, PNG, or WebP.' });
      }

      const ai = getGeminiClient();

      const prompt = [
        `You are an expert indoor environmental quality (IEQ) and building science specialist for BreatheClear.`,
        `Analyze this photograph of a ${roomType.replace(/_/g, ' ').toLowerCase()} for real, visible indoor air quality (IAQ) risks and practical airflow opportunities.`,
        `Household context:`,
        `- Vulnerabilities: ${Array.isArray(familyProfile.vulnerabilities) && familyProfile.vulnerabilities.length > 0 ? familyProfile.vulnerabilities.join(', ') : 'General adult household'}`,
        `- Cooking setup: ${familyProfile.cookingSetup || 'Unknown'}, Range hood: ${familyProfile.rangeHood || 'Unknown'}`,
        `- Air purifier: ${familyProfile.airPurifier || 'Unknown'}, Window layout: ${familyProfile.windowVentilation || 'Unknown'}`,
        `- Live outdoor AQI right now: US AQI ${outdoorAqi} (dominant pollutant: ${dominantPollutant})`,
        ``,
        `Instructions:`,
        `1. Ground every observation strictly in what is actually visible in the photograph (e.g., gas burners, range hood height/style, window framing/gaps, curtains blocking airflow, dust-trapping textiles, moisture signs, potted soil, street proximity outside window, clutter near vents).`,
        `2. Identify 2 to 4 concrete indoor air pollution risks with specific pollutant types (NO2, PM2.5, VOCs, CO2 buildup, mold spores, dust allergens, or outdoor traffic infiltration).`,
        `3. Return EXACTLY 3 practical, high-impact indoor air quality hacks that are either "Zero Cost", "Under $15", or "Under $40" — at least 2 must be "Zero Cost" or "Under $15". Make steps concrete and immediate.`,
        `4. Give concise outdoor-aware ventilation advice factoring in today's outdoor AQI (${outdoorAqi}).`,
        `Keep strings concise and crisp so they fit cleanly on mobile screens.`,
      ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
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
                description: '2-sentence objective summary of what is visible in the room affecting air quality (max 450 chars).',
              },
              overallRiskLevel: {
                type: Type.STRING,
                enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'],
              },
              ventilationAdvice: {
                type: Type.STRING,
                description: 'Specific window/exhaust action combining room layout and live outdoor AQI (max 450 chars).',
              },
              detectedRisks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING, description: 'Specific visible source in photo.' },
                    pollutantType: { type: Type.STRING, description: 'e.g. NO2 & Ultrafine PM2.5' },
                    severity: { type: Type.STRING, enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] },
                    explanation: { type: Type.STRING, description: '1-2 sentence explanation tailored to household.' },
                  },
                  required: ['source', 'pollutantType', 'severity', 'explanation'],
                },
              },
              hacks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING, description: 'Unique short id like hack-1, hack-2, hack-3' },
                    title: { type: Type.STRING, description: 'Clear action-oriented title' },
                    costTier: { type: Type.STRING, enum: ['Zero Cost', 'Under $15', 'Under $40'] },
                    estimatedImpact: { type: Type.STRING, description: 'Quantified expected IAQ gain, e.g. Up to 50% lower peak NO2' },
                    steps: { type: Type.STRING, description: 'Clear 1-2 sentence how-to instruction.' },
                    whyItWorks: { type: Type.STRING, description: 'Brief building-science rationale.' },
                  },
                  required: ['id', 'title', 'costTier', 'estimatedImpact', 'steps', 'whyItWorks'],
                },
              },
            },
            required: ['roomSummary', 'overallRiskLevel', 'ventilationAdvice', 'detectedRisks', 'hacks'],
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        return res.status(502).json({ error: 'Gemini returned an empty room analysis.' });
      }
      const parsed = JSON.parse(rawText);

      // Enforce strict volumetric bounds matching firebase-blueprint.json
      const result = {
        roomType,
        overallRiskLevel: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'].includes(parsed.overallRiskLevel)
          ? parsed.overallRiskLevel
          : 'MODERATE',
        roomSummary: String(parsed.roomSummary || '').slice(0, 580),
        outdoorAqiAtScan: Math.max(0, Math.min(500, Math.round(outdoorAqi))),
        ventilationAdvice: String(parsed.ventilationAdvice || '').slice(0, 580),
        detectedRisks: (Array.isArray(parsed.detectedRisks) ? parsed.detectedRisks : []).slice(0, 6),
        hacks: (Array.isArray(parsed.hacks) ? parsed.hacks : []).slice(0, 3).map((h: any, idx: number) => ({
          id: String(h.id || `hack-${idx + 1}`).slice(0, 32),
          title: String(h.title || 'Airflow Improvement').slice(0, 120),
          costTier: ['Zero Cost', 'Under $15', 'Under $40'].includes(h.costTier) ? h.costTier : 'Zero Cost',
          estimatedImpact: String(h.estimatedImpact || 'Noticeable particulate reduction').slice(0, 120),
          steps: String(h.steps || '').slice(0, 300),
          whyItWorks: String(h.whyItWorks || '').slice(0, 300),
        })),
        completedHackIds: [],
      };

      return res.json(result);
    } catch (err: any) {
      const readable = extractApiErrorMessage(String(err?.message || ''), 'Room air quality analysis failed.');
      const keyErr = isGeminiKeyError(err, readable);
      const status = err?.status === 429 ? 429 : keyErr ? 424 : 500;
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
      const homeLocation = req.body?.homeLocation;
      const schedule: any[] = Array.isArray(req.body?.schedule) ? req.body.schedule.slice(0, 6) : [];
      const familyProfile = req.body?.familyProfile || {};
      const currentAqi = Number(req.body?.currentAqi ?? 45);
      const hourlyForecast: any[] = Array.isArray(req.body?.hourlyForecast) ? req.body.hourlyForecast.slice(0, 24) : [];

      if (!homeLocation || !Number.isFinite(Number(homeLocation.lat)) || !Number.isFinite(Number(homeLocation.lng))) {
        return res.status(400).json({ error: 'Valid home location coordinates are required.' });
      }
      if (schedule.length === 0) {
        return res.status(400).json({ error: 'Add at least one daily routine stop to generate swaps.' });
      }

      const apiKey = getMapsApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'Google Maps Platform API key is not configured.' });
      }

      const homeLat = Number(homeLocation.lat);
      const homeLng = Number(homeLocation.lng);
      const vehicleEmissionType = ['GASOLINE', 'DIESEL', 'HYBRID', 'ELECTRIC'].includes(
        familyProfile.vehicleEmissionType
      )
        ? familyProfile.vehicleEmissionType
        : 'GASOLINE';

      // Helper: Resolve real place via Places API (New)
      async function resolvePlace(query: string, biasLat: number, biasLng: number) {
        const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
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
            throw Object.assign(new Error('Google Maps Places API quota reached.'), { quotaExceeded: true, status: 429 });
          }
          return null;
        }
        const data = JSON.parse(txt);
        const p = data.places?.[0];
        if (!p?.location) return null;
        return {
          name: p.displayName?.text || query,
          address: p.formattedAddress || '',
          lat: p.location.latitude,
          lng: p.location.longitude,
          googleMapsUri: p.googleMapsUri || '',
          placeType: p.primaryTypeDisplayName?.text || '',
        };
      }

      // Helper: Compute route via Routes API (v2:computeRoutes)
      async function computeRoute(
        origLat: number,
        origLng: number,
        destLat: number,
        destLng: number,
        travelMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK'
      ) {
        const body: any = {
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
            throw Object.assign(new Error('Google Maps Routes API quota reached.'), { quotaExceeded: true, status: 429 });
          }
          return null;
        }
        const data = JSON.parse(txt);
        const routes: any[] = data.routes || [];
        if (routes.length === 0) return null;

        const defaultRoute = routes.find((r) => r.routeLabels?.includes('DEFAULT_ROUTE')) || routes[0];
        const ecoRoute = routes.find((r) => r.routeLabels?.includes('FUEL_EFFICIENT')) || defaultRoute;

        return {
          mode: travelMode,
          distanceMeters: Number(defaultRoute.distanceMeters || 0),
          durationSeconds: parseDurationSeconds(defaultRoute.duration),
          encodedPolyline: defaultRoute.polyline?.encodedPolyline || '',
          fuelMicroliters: Number(defaultRoute.travelAdvisory?.fuelConsumptionMicroliters || 0),
          ecoDistanceMeters: Number(ecoRoute.distanceMeters || defaultRoute.distanceMeters || 0),
          ecoDurationSeconds: parseDurationSeconds(ecoRoute.duration || defaultRoute.duration),
          ecoFuelMicroliters: Number(ecoRoute.travelAdvisory?.fuelConsumptionMicroliters || 0),
          ecoPolyline: ecoRoute.polyline?.encodedPolyline || defaultRoute.polyline?.encodedPolyline || '',
        };
      }

      // Process each routine stop with real Places & Routes calls
      const enrichedLegs = await Promise.all(
        schedule.map(async (item: any, idx: number) => {
          let destPlace =
            Number.isFinite(Number(item.destinationLat)) && Number.isFinite(Number(item.destinationLng))
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
            // Fallback search for a nearby civic/park landmark if query didn't resolve
            destPlace = await resolvePlace(`${item.title} near ${homeLocation.label}`, homeLat, homeLng);
          }

          if (!destPlace) {
            return null;
          }

          const currentMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK' = ['DRIVE', 'TRANSIT', 'BICYCLE', 'WALK'].includes(
            item.currentMode
          )
            ? item.currentMode
            : 'DRIVE';

          // Run real Routes API comparisons + nearby transit/park Place discovery in parallel
          const [driveRoute, transitRoute, bikeRoute, walkRoute, nearbyTransitOrPark] = await Promise.all([
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

          const baselineRoute =
            currentMode === 'DRIVE'
              ? driveRoute
              : currentMode === 'TRANSIT'
                ? transitRoute || driveRoute
                : currentMode === 'BICYCLE'
                  ? bikeRoute || walkRoute
                  : walkRoute || bikeRoute;

          const distanceMeters = baselineRoute?.distanceMeters || driveRoute?.distanceMeters || 2500;
          const distanceKm = Math.max(0.2, Math.round((distanceMeters / 1000) * 10) / 10);

          // Select cleanest practical low-emission alternative based on real Routes API availability
          let recommendedMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK' = currentMode;
          let recommendedRoute = baselineRoute;

          if (currentMode === 'DRIVE') {
            if (walkRoute && walkRoute.distanceMeters <= 1800 && currentAqi <= 85) {
              recommendedMode = 'WALK';
              recommendedRoute = walkRoute;
            } else if (bikeRoute && bikeRoute.distanceMeters <= 6500 && currentAqi <= 95) {
              recommendedMode = 'BICYCLE';
              recommendedRoute = bikeRoute;
            } else if (transitRoute) {
              recommendedMode = 'TRANSIT';
              recommendedRoute = transitRoute;
            } else if (driveRoute) {
              recommendedMode = 'DRIVE';
              recommendedRoute = {
                ...driveRoute,
                distanceMeters: driveRoute.ecoDistanceMeters,
                durationSeconds: driveRoute.ecoDurationSeconds,
                encodedPolyline: driveRoute.ecoPolyline,
                fuelMicroliters: driveRoute.ecoFuelMicroliters,
              };
            }
          } else if (currentMode === 'TRANSIT' && walkRoute && walkRoute.distanceMeters <= 1600 && currentAqi <= 75) {
            recommendedMode = 'WALK';
            recommendedRoute = walkRoute;
          } else if (currentMode === 'WALK' || currentMode === 'BICYCLE') {
            // If AQI is unhealthy (>100), recommend shifting to TRANSIT or cleaner window
            if (currentAqi > 100 && transitRoute) {
              recommendedMode = 'TRANSIT';
              recommendedRoute = transitRoute;
            }
          }

          // Deterministic physics/EPA emission & inhalation exposure calculations
          // Tailpipe CO2e (grams per km): Gasoline ~215g/km, Diesel ~235g/km, Hybrid ~125g/km, EV ~35g/km grid, Transit ~58g/km, Walk/Bike 0g/km
          const co2FactorMap: Record<string, number> = {
            DRIVE_GASOLINE: 215,
            DRIVE_DIESEL: 235,
            DRIVE_HYBRID: 125,
            DRIVE_ELECTRIC: 35,
            DRIVE_NONE: 215,
            TRANSIT: 58,
            BICYCLE: 0,
            WALK: 0,
          };
          const noxFactorMap: Record<string, number> = {
            DRIVE_GASOLINE: 180,
            DRIVE_DIESEL: 460,
            DRIVE_HYBRID: 95,
            DRIVE_ELECTRIC: 0,
            DRIVE_NONE: 180,
            TRANSIT: 32,
            BICYCLE: 0,
            WALK: 0,
          };

          const baseCo2PerKm =
            currentMode === 'DRIVE' ? co2FactorMap[`DRIVE_${vehicleEmissionType}`] || 215 : co2FactorMap[currentMode] ?? 0;
          const recCo2PerKm =
            recommendedMode === 'DRIVE'
              ? Math.round((co2FactorMap[`DRIVE_${vehicleEmissionType}`] || 215) * 0.88) // Eco-friendly route ~12% fuel savings
              : co2FactorMap[recommendedMode] ?? 0;

          const baseNoxPerKm =
            currentMode === 'DRIVE' ? noxFactorMap[`DRIVE_${vehicleEmissionType}`] || 180 : noxFactorMap[currentMode] ?? 0;
          const recNoxPerKm =
            recommendedMode === 'DRIVE'
              ? Math.round((noxFactorMap[`DRIVE_${vehicleEmissionType}`] || 180) * 0.88)
              : noxFactorMap[recommendedMode] ?? 0;

          // Round-trip or single leg (each schedule item represents a planned trip leg)
          const communityCo2GramsSaved = Math.max(0, Math.round((baseCo2PerKm - recCo2PerKm) * distanceKm));
          const communityNoxMgSaved = Math.max(0, Math.round((baseNoxPerKm - recNoxPerKm) * distanceKm));

          // Personal inhaled PM2.5 exposure (µg) based on ambient PM2.5 proxy from AQI, roadway micro-environment multiplier (in-car traffic corridor = 1.65x ambient, transit = 1.05x, greenway walk/bike off-arterial = 0.85x), and duration
          const ambientPm25 = Math.max(6, currentAqi * 0.34);
          const baseDurHours = Math.max(0.15, (baselineRoute?.durationSeconds || 1200) / 3600);
          const recDurHours = Math.max(0.15, (recommendedRoute?.durationSeconds || 1100) / 3600);

          const baseInhaleRate = currentMode === 'DRIVE' ? 0.55 : currentMode === 'TRANSIT' ? 0.65 : 1.1; // m3/hr
          const baseCorridorMult = currentMode === 'DRIVE' ? 1.75 : currentMode === 'TRANSIT' ? 1.15 : 1.35;
          const baseExposureUg = ambientPm25 * baseCorridorMult * baseInhaleRate * baseDurHours;

          // Shifting off peak traffic / using greenway / eco-route reduces corridor exposure
          const recInhaleRate = recommendedMode === 'DRIVE' ? 0.55 : recommendedMode === 'TRANSIT' ? 0.65 : 0.95;
          const recCorridorMult =
            recommendedMode === 'TRANSIT' ? 0.88 : recommendedMode === 'DRIVE' ? 1.25 : 0.72;
          const recExposureUg = Math.min(baseExposureUg * 0.85, ambientPm25 * recCorridorMult * recInhaleRate * recDurHours);

          const personalPm25UgSaved = Math.max(0.6, Math.round((baseExposureUg - recExposureUg) * 10) / 10);
          const personalPm25ReductionPct = Math.max(
            12,
            Math.min(68, Math.round(((baseExposureUg - recExposureUg) / Math.max(1, baseExposureUg)) * 100))
          );

          return {
            id: String(item.id || `leg-${idx + 1}`),
            time: String(item.time || '08:30 AM'),
            title: String(item.title || `Trip ${idx + 1}`),
            destinationName: destPlace.name,
            destinationAddress: destPlace.address,
            destinationLat: destPlace.lat,
            destinationLng: destPlace.lng,
            destinationMapsUri: destPlace.googleMapsUri,
            currentMode,
            recommendedMode,
            distanceKm,
            currentDurationMin: Math.max(2, Math.round((baselineRoute?.durationSeconds || 900) / 60)),
            recommendedDurationMin: Math.max(2, Math.round((recommendedRoute?.durationSeconds || 900) / 60)),
            baselinePolyline: baselineRoute?.encodedPolyline || '',
            recommendedPolyline: recommendedRoute?.encodedPolyline || baselineRoute?.encodedPolyline || '',
            nearbyCleanStop: nearbyTransitOrPark,
            personalPm25UgSaved,
            personalPm25ReductionPct,
            communityCo2GramsSaved,
            communityNoxMgSaved,
          };
        })
      );

      const validLegs = enrichedLegs.filter((l): l is NonNullable<typeof l> => l !== null);
      if (validLegs.length === 0) {
        return res.status(400).json({ error: 'Could not resolve destinations via Google Places API. Try more specific place names.' });
      }

      // Use Gemini (gemini-4-hydrogen) to generate crisp, human-actionable headlines, timing windows, and rationale grounded ONLY in the real Routes & Places results
      const ai = getGeminiClient();
      const forecastSummary = hourlyForecast
        .slice(0, 14)
        .map((h: any) => `${h.localHourLabel}: AQI ${h.usAqi} (${h.status})`)
        .join(', ');

      const geminiPrompt = [
        `You are BreatheClear's urban clean-air commute & routine coach.`,
        `For each verified trip leg below (computed from Google Maps Routes API and Places API), write a concise, practical swap headline, recommended departure window (aligned to lower AQI hours), and 1-2 sentence rationale.`,
        `STRICT RULE: Only reference the exact destination names, nearby transit/park stops, distances, and durations provided below. Do NOT invent any new place names or addresses.`,
        `Household vulnerabilities: ${(familyProfile.vulnerabilities || []).join(', ') || 'General'}`,
        `Today's hourly AQI forecast: ${forecastSummary || `Current US AQI ${currentAqi}`}`,
        `Verified Legs JSON:`,
        JSON.stringify(
          validLegs.map((l) => ({
            id: l.id,
            time: l.time,
            title: l.title,
            destinationName: l.destinationName,
            currentMode: l.currentMode,
            recommendedMode: l.recommendedMode,
            distanceKm: l.distanceKm,
            currentDurationMin: l.currentDurationMin,
            recommendedDurationMin: l.recommendedDurationMin,
            nearbyCleanStop: l.nearbyCleanStop?.name || null,
            personalPm25ReductionPct: l.personalPm25ReductionPct,
            communityCo2GramsSaved: l.communityCo2GramsSaved,
          }))
        ),
      ].join('\n');

      const aiRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: geminiPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              planTitle: { type: Type.STRING, description: 'Concise daily plan headline (max 80 chars).' },
              legAdvice: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    recommendedTimeWindow: { type: Type.STRING, description: 'e.g. Leave at 7:45 AM (low PM2.5)' },
                    swapHeadline: { type: Type.STRING, description: 'Punchy 1-line swap action' },
                    swapRationale: { type: Type.STRING, description: '1-2 concise sentences citing real route/stop benefit' },
                  },
                  required: ['id', 'recommendedTimeWindow', 'swapHeadline', 'swapRationale'],
                },
              },
            },
            required: ['planTitle', 'legAdvice'],
          },
        },
      });

      const aiParsed = JSON.parse((aiRes.text ?? '{}').trim() || '{}');
      const adviceById: Record<string, any> = {};
      for (const a of aiParsed.legAdvice || []) {
        if (a?.id) adviceById[a.id] = a;
      }

      const swaps = validLegs.map((leg) => {
        const adv = adviceById[leg.id];
        return {
          ...leg,
          recommendedTimeWindow: String(adv?.recommendedTimeWindow || `Around ${leg.time}`).slice(0, 80),
          swapHeadline: String(
            adv?.swapHeadline ||
              (leg.currentMode !== leg.recommendedMode
                ? `Swap ${leg.currentMode.toLowerCase()} for ${leg.recommendedMode.toLowerCase()} (${leg.distanceKm} km)`
                : `Use cleaner timing & eco corridor (${leg.distanceKm} km)`)
          ).slice(0, 140),
          swapRationale: String(
            adv?.swapRationale ||
              `Switching to ${leg.recommendedMode.toLowerCase()} takes ${leg.recommendedDurationMin} min and trims inhaled PM2.5 by ~${leg.personalPm25ReductionPct}%.`
          ).slice(0, 320),
        };
      });

      const acceptedSwapIds = swaps.map((s) => s.id);
      const personalPm25UgSaved = Math.round(swaps.reduce((sum, s) => sum + s.personalPm25UgSaved, 0) * 10) / 10;
      const personalPm25ReductionPct = Math.round(
        swaps.reduce((sum, s) => sum + s.personalPm25ReductionPct, 0) / Math.max(1, swaps.length)
      );
      const communityCo2GramsSaved = swaps.reduce((sum, s) => sum + s.communityCo2GramsSaved, 0);
      const communityNoxMgSaved = swaps.reduce((sum, s) => sum + s.communityNoxMgSaved, 0);

      return res.json({
        planTitle: String(aiParsed.planTitle || 'Clean-Air Daily Routine Plan').slice(0, 115),
        locationLabel: String(homeLocation.label || 'Home').slice(0, 195),
        swaps,
        acceptedSwapIds,
        personalPm25ReductionPct,
        personalPm25UgSaved,
        communityCo2GramsSaved,
        communityNoxMgSaved,
      });
    } catch (err: any) {
      const readable = extractApiErrorMessage(String(err?.message || ''), 'Failed to compute clean-air routine swaps.');
      const keyErr = isGeminiKeyError(err, readable);
      const status = err?.status === 429 || err?.quotaExceeded ? 429 : keyErr ? 424 : 500;
      console.warn('Routine plan failed:', readable);
      return res.status(status).json({
        error: keyErr
          ? `Gemini API key was rejected (${readable}). Please check or select a valid Gemini API key in Settings > Secrets.`
          : readable,
        quotaExceeded: Boolean(err?.quotaExceeded || status === 429),
      });
    }
  });

  // Frontend Vite middleware (dev) or static dist serving (prod)
  if (process.env.NODE_ENV !== 'production') {
    // When HMR/WS is disabled in middleware mode, Vite 8's default /@vite/client still attempts
    // a WebSocket connection on port 24678 and throws an unhandled rejection. Serve a clean
    // WebSocket-free shim with full CSS style injection and no-op HMR hooks.
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
