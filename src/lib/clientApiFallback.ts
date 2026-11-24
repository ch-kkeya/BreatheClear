import { GoogleGenAI, Type } from '@google/genai';

const GMP_SOLUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';

function getBrowserMapsApiKey(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
}

function getBrowserGeminiClient(): GoogleGenAI {
  const apiKey = ((import.meta.env as any).VITE_FALLBACK_GEMINI_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }
  return new GoogleGenAI({ apiKey });
}

async function generateContentWithModelFallback(
  ai: GoogleGenAI,
  models: string[],
  params: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>
) {
  let lastErr: any;
  for (const model of models) {
    try {
      return await ai.models.generateContent({ ...params, model });
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || '');
      if (err?.status === 404 || msg.includes('not found') || msg.includes('NOT_FOUND') || msg.includes('not supported')) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

export async function handleClientApiFallback<T>(url: string, options?: RequestInit): Promise<T> {
  const body = options?.body ? JSON.parse(String(options.body)) : {};

  if (url.startsWith('/api/config')) {
    return { mapsApiKey: getBrowserMapsApiKey() } as unknown as T;
  }

  if (url.startsWith('/api/air-quality/overview')) {
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const vulnerabilities: string[] = Array.isArray(body?.vulnerabilities) ? body.vulnerabilities : [];
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
      fetch(openMeteoUrl.toString()),
      apiKey ? fetch(weatherCurrentUrl.toString()).catch(() => null) : Promise.resolve(null),
      apiKey ? fetch(weatherHourlyUrl.toString()).catch(() => null) : Promise.resolve(null),
    ]);

    if (!omRes.ok) {
      throw new Error(`Open-Meteo Air Quality API error (${omRes.status})`);
    }
    const omData = await omRes.json();
    const curr = omData.current || {};
    const weatherCurr = weatherCurrRes && weatherCurrRes.ok ? await weatherCurrRes.json() : null;
    const weatherHourly = weatherHourlyRes && weatherHourlyRes.ok ? await weatherHourlyRes.json() : { forecastHours: [] };
    const timeZoneId: string | undefined = weatherCurr?.timeZone?.id || weatherHourly?.timeZone?.id;

    const usAqi = Math.max(0, Math.round(Number(curr.us_aqi ?? 25)));
    const uaqi = Math.max(0, Math.min(100, Math.round(100 - usAqi * 0.48)));
    const category = getUsAqiCategory(usAqi);

    const subIndexes: Array<{ code: string; subAqi: number }> = [
      { code: 'pm25', subAqi: Number(curr.us_aqi_pm2_5 ?? 0) },
      { code: 'pm10', subAqi: Number(curr.us_aqi_pm10 ?? 0) },
      { code: 'o3', subAqi: Number(curr.us_aqi_ozone ?? 0) },
      { code: 'no2', subAqi: Number(curr.us_aqi_nitrogen_dioxide ?? 0) },
      { code: 'so2', subAqi: Number(curr.us_aqi_sulphur_dioxide ?? 0) },
      { code: 'co', subAqi: Number(curr.us_aqi_carbon_monoxide ?? 0) },
    ].sort((a, b) => b.subAqi - a.subAqi);
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

    const hasHighVulnerability = vulnerabilities.some((v) =>
      ['ASTHMA_COPD', 'YOUNG_CHILDREN', 'SENIORS_65', 'PREGNANCY', 'CARDIOVASCULAR'].includes(v)
    );
    const safeThresholdAqi = hasHighVulnerability ? 45 : 65;
    const moderateThresholdAqi = hasHighVulnerability ? 75 : 100;

    const weatherByHour: Record<string, any> = {};
    for (const wh of weatherHourly?.forecastHours || []) {
      const key = typeof wh?.interval?.startTime === 'string' ? wh.interval.startTime.slice(0, 13) : '';
      if (key) weatherByHour[key] = wh;
    }

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
        const segAvg = timeline.slice(curStart, i).reduce((acc, s) => acc + s.usAqi, 0) / segLen;
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

    return {
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
    } as unknown as T;
  }

  if (url.startsWith('/api/places/search')) {
    const query = String(body?.query || '').trim();
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const radiusMeters = Math.min(50000, Math.max(500, Number(body?.radiusMeters || 8000)));
    const apiKey = getBrowserMapsApiKey();
    if (!apiKey) throw new Error('Google Maps API key not configured.');

    const reqBody: any = {
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
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
      },
      body: JSON.stringify(reqBody),
    });
    if (!placeRes.ok) {
      throw new Error(`Places API error (${placeRes.status})`);
    }
    const parsed = await placeRes.json();
    const places = (parsed.places || []).map((p: any) => ({
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
    const imageBase64 = String(body?.imageBase64 || '');
    const mimeType = String(body?.mimeType || 'image/jpeg');
    const roomType = String(body?.roomType || 'KITCHEN');
    const outdoorAqi = Number(body?.outdoorAqi ?? 40);
    const dominantPollutant = String(body?.dominantPollutant || 'PM2.5');
    const familyProfile = body?.familyProfile || {};

    const ai = getBrowserGeminiClient();
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

    const response = await generateContentWithModelFallback(
      ai,
      ['gemini-2.5-flash', 'gemini-2.0-flash'],
      {
        contents: {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              roomSummary: { type: Type.STRING },
              overallRiskLevel: { type: Type.STRING, enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] },
              ventilationAdvice: { type: Type.STRING },
              detectedRisks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING },
                    pollutantType: { type: Type.STRING },
                    severity: { type: Type.STRING, enum: ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] },
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
                    costTier: { type: Type.STRING, enum: ['Zero Cost', 'Under $15', 'Under $40'] },
                    estimatedImpact: { type: Type.STRING },
                    steps: { type: Type.STRING },
                    whyItWorks: { type: Type.STRING },
                  },
                  required: ['id', 'title', 'costTier', 'estimatedImpact', 'steps', 'whyItWorks'],
                },
              },
            },
            required: ['roomSummary', 'overallRiskLevel', 'ventilationAdvice', 'detectedRisks', 'hacks'],
          },
        },
      }
    );

    const parsed = JSON.parse((response.text ?? '{}').trim());
    return {
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
    } as unknown as T;
  }

  if (url.startsWith('/api/routine/plan')) {
    const homeLocation = body?.homeLocation;
    const schedule: any[] = Array.isArray(body?.schedule) ? body.schedule.slice(0, 6) : [];
    const familyProfile = body?.familyProfile || {};
    const currentAqi = Number(body?.currentAqi ?? 45);
    const hourlyForecast: any[] = Array.isArray(body?.hourlyForecast) ? body.hourlyForecast.slice(0, 24) : [];
    const apiKey = getBrowserMapsApiKey();
    const homeLat = Number(homeLocation?.lat);
    const homeLng = Number(homeLocation?.lng);
    const vehicleEmissionType = ['GASOLINE', 'DIESEL', 'HYBRID', 'ELECTRIC'].includes(familyProfile.vehicleEmissionType)
      ? familyProfile.vehicleEmissionType
      : 'GASOLINE';

    async function resolvePlace(query: string, biasLat: number, biasLng: number) {
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
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
      const data = await resp.json();
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

    async function computeRoute(
      origLat: number,
      origLng: number,
      destLat: number,
      destLng: number,
      travelMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK'
    ) {
      const reqBody: any = {
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
      const data = await resp.json();
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
          destPlace = await resolvePlace(`${item.title} near ${homeLocation?.label}`, homeLat, homeLng);
        }
        if (!destPlace) return null;

        const currentMode: 'DRIVE' | 'TRANSIT' | 'BICYCLE' | 'WALK' = ['DRIVE', 'TRANSIT', 'BICYCLE', 'WALK'].includes(
          item.currentMode
        )
          ? item.currentMode
          : 'DRIVE';

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
        } else if ((currentMode === 'WALK' || currentMode === 'BICYCLE') && currentAqi > 100 && transitRoute) {
          recommendedMode = 'TRANSIT';
          recommendedRoute = transitRoute;
        }

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
            ? Math.round((co2FactorMap[`DRIVE_${vehicleEmissionType}`] || 215) * 0.88)
            : co2FactorMap[recommendedMode] ?? 0;

        const baseNoxPerKm =
          currentMode === 'DRIVE' ? noxFactorMap[`DRIVE_${vehicleEmissionType}`] || 180 : noxFactorMap[currentMode] ?? 0;
        const recNoxPerKm =
          recommendedMode === 'DRIVE'
            ? Math.round((noxFactorMap[`DRIVE_${vehicleEmissionType}`] || 180) * 0.88)
            : noxFactorMap[recommendedMode] ?? 0;

        const communityCo2GramsSaved = Math.max(0, Math.round((baseCo2PerKm - recCo2PerKm) * distanceKm));
        const communityNoxMgSaved = Math.max(0, Math.round((baseNoxPerKm - recNoxPerKm) * distanceKm));

        const ambientPm25 = Math.max(6, currentAqi * 0.34);
        const baseDurHours = Math.max(0.15, (baselineRoute?.durationSeconds || 1200) / 3600);
        const recDurHours = Math.max(0.15, (recommendedRoute?.durationSeconds || 1100) / 3600);

        const baseInhaleRate = currentMode === 'DRIVE' ? 0.55 : currentMode === 'TRANSIT' ? 0.65 : 1.1;
        const baseCorridorMult = currentMode === 'DRIVE' ? 1.75 : currentMode === 'TRANSIT' ? 1.15 : 1.35;
        const baseExposureUg = ambientPm25 * baseCorridorMult * baseInhaleRate * baseDurHours;

        const recInhaleRate = recommendedMode === 'DRIVE' ? 0.55 : recommendedMode === 'TRANSIT' ? 0.65 : 0.95;
        const recCorridorMult = recommendedMode === 'TRANSIT' ? 0.88 : recommendedMode === 'DRIVE' ? 1.25 : 0.72;
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
      throw new Error('Could not resolve destinations via Google Places API.');
    }

    let aiParsed: any = {};
    try {
      const ai = getBrowserGeminiClient();
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

      const aiRes = await generateContentWithModelFallback(
        ai,
        ['gemini-2.5-flash', 'gemini-2.0-flash'],
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
      aiParsed = JSON.parse((aiRes.text ?? '{}').trim() || '{}');
    } catch {
      aiParsed = {};
    }

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

    return {
      planTitle: String(aiParsed.planTitle || 'Clean-Air Daily Routine Plan').slice(0, 115),
      locationLabel: String(homeLocation?.label || 'Home').slice(0, 195),
      swaps,
      acceptedSwapIds,
      personalPm25ReductionPct,
      personalPm25UgSaved,
      communityCo2GramsSaved,
      communityNoxMgSaved,
    } as unknown as T;
  }

  throw new Error(`Unsupported API endpoint: ${url}`);
}
