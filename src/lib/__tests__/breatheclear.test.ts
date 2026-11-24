import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline, getAqiTone, getRiskTone } from '../aqiUtils';
import {
  buildAirQualityOverviewFromRaw,
  buildHealthRecommendations,
  buildRoomScanPrompt,
  buildRoutinePlanPrompt,
  computeCommuteLegImpact,
  extractApiErrorMessage,
  formatPollutantName,
  formatUnit,
  getErrorMessage,
  getUsAqiCategory,
  isGeminiKeyError,
  isQuotaError,
  mergeSwapsWithGeminiAdvice,
  parseDurationSeconds,
  sanitizeRoomScanResponse,
} from '../airQualityDomain';

describe('AQI & UI Tone Scales (aqiUtils)', () => {
  it('classifies US EPA AQI values into accurate visual tones', () => {
    assert.equal(getAqiTone(28).shortLabel, 'Good');
    assert.equal(getAqiTone(50).label, 'Good Air Quality');
    assert.equal(getAqiTone(72).shortLabel, 'Moderate');
    assert.equal(getAqiTone(125).shortLabel, 'Sensitive');
    assert.equal(getAqiTone(180).shortLabel, 'Unhealthy');
  });

  it('returns matching labels and CSS classes for indoor IAQ risk levels', () => {
    assert.equal(getRiskTone('LOW').label, 'Low Risk');
    assert.equal(getRiskTone('MODERATE').label, 'Moderate Risk');
    assert.equal(getRiskTone('ELEVATED').label, 'Elevated Risk');
    assert.equal(getRiskTone('HIGH').label, 'High Risk');
  });

  it('decodes Google Maps encoded polylines accurately', () => {
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const points = decodePolyline(encoded);
    assert.equal(points.length, 3);
    assert.ok(Math.abs(points[0].lat - 38.5) < 0.01);
    assert.ok(Math.abs(points[0].lng - -120.2) < 0.01);
    assert.deepEqual(decodePolyline(''), []);
  });
});

describe('Air Quality Domain Utilities & Error Classifiers', () => {
  it('formats pollutant codes and units into human-readable display names', () => {
    assert.equal(formatPollutantName('pm25'), 'PM2.5');
    assert.equal(formatPollutantName('o3'), 'Ozone (O₃)');
    assert.equal(formatPollutantName('no2'), 'Nitrogen Dioxide (NO₂)');
    assert.equal(formatUnit('MICROGRAMS_PER_CUBIC_METER'), 'µg/m³');
    assert.equal(formatUnit('PARTS_PER_BILLION'), 'ppb');
    assert.equal(formatUnit('PARTS_PER_MILLION'), 'ppm');
  });

  it('parses Google Routes duration strings into integer seconds', () => {
    assert.equal(parseDurationSeconds('945s'), 945);
    assert.equal(parseDurationSeconds('120.4s'), 120);
    assert.equal(parseDurationSeconds(undefined), 0);
    assert.equal(parseDurationSeconds('invalid'), 0);
  });

  it('classifies US AQI categories and builds population-specific health recommendations', () => {
    assert.equal(getUsAqiCategory(40), 'Good air quality');
    assert.equal(getUsAqiCategory(85), 'Moderate air quality');
    assert.equal(getUsAqiCategory(135), 'Unhealthy for sensitive groups');
    assert.equal(getUsAqiCategory(175), 'Unhealthy air quality');
    assert.equal(getUsAqiCategory(250), 'Very unhealthy air quality');
    assert.equal(getUsAqiCategory(340), 'Hazardous air quality');

    const recs = buildHealthRecommendations(135, 'PM2.5');
    assert.ok(recs.lungDiseasePopulation.includes('HEPA'));
    assert.ok(recs.pregnantWomen.includes('N95'));
  });

  it('extracts structured API error messages and detects quota/auth errors', () => {
    const jsonErr = JSON.stringify({
      error: {
        message: 'API key not valid',
        details: [{ reason: 'API_KEY_INVALID' }],
      },
    });
    const readable = extractApiErrorMessage(jsonErr, 'Fallback');
    assert.equal(readable, 'API key not valid (API_KEY_INVALID)');
    assert.equal(isGeminiKeyError({ status: 401 }, readable), true);
    assert.equal(isQuotaError(429, ''), true);
    assert.equal(isQuotaError(403, 'RESOURCE_EXHAUSTED'), true);
    assert.equal(getErrorMessage(new Error('Custom error'), 'Default'), 'Custom error');
  });
});

describe('24-Hour Safe Ventilation Window Synthesis (buildAirQualityOverviewFromRaw)', () => {
  const sampleTimes = [
    '2026-11-24T12:00',
    '2026-11-24T13:00',
    '2026-11-24T14:00',
    '2026-11-24T15:00',
  ];

  it('calibrates tighter AQI threshold (45) for sensitive households and finds best SAFE_OPEN window', () => {
    const overview = buildAirQualityOverviewFromRaw({
      lat: 37.7599,
      lng: -122.4148,
      vulnerabilities: ['ASTHMA_COPD', 'YOUNG_CHILDREN'],
      nowIso: '2026-11-24T12:00:00Z',
      openMeteoData: {
        current: {
          us_aqi: 38,
          pm2_5: 9.2,
          pm10: 18.4,
          nitrogen_dioxide: 14.1,
          ozone: 42.0,
          us_aqi_pm2_5: 38,
          us_aqi_pm10: 17,
          us_aqi_ozone: 35,
          us_aqi_nitrogen_dioxide: 13,
        },
        hourly: {
          time: sampleTimes,
          us_aqi: [32, 36, 55, 85],
          us_aqi_pm2_5: [32, 36, 55, 85],
          us_aqi_pm10: [15, 16, 25, 40],
          us_aqi_ozone: [20, 22, 30, 45],
          us_aqi_nitrogen_dioxide: [10, 12, 18, 30],
        },
      },
      weatherCurr: {
        temperature: { degrees: 19.4 },
        feelsLikeTemperature: { degrees: 19.0 },
        relativeHumidity: 58,
        wind: { speed: { value: 12 }, direction: { cardinal: 'NORTH_WEST' } },
        weatherCondition: { description: { text: 'Mostly Sunny' } },
        precipitation: { probability: { percent: 10 } },
        timeZone: { id: 'UTC' },
      },
      weatherHourly: {
        timeZone: { id: 'UTC' },
        forecastHours: [
          {
            interval: { startTime: '2026-11-24T12:00:00Z' },
            temperature: { degrees: 19 },
            relativeHumidity: 55,
            wind: { speed: { value: 12 } },
            precipitation: { probability: { percent: 5 } },
          },
          {
            interval: { startTime: '2026-11-24T13:00:00Z' },
            temperature: { degrees: 20 },
            relativeHumidity: 54,
            wind: { speed: { value: 10 } },
            precipitation: { probability: { percent: 5 } },
          },
        ],
      },
    });

    assert.equal(overview.sensitivityThresholdAqi, 45);
    assert.equal(overview.dominantPollutant, 'pm25');
    assert.equal(overview.timeline.length, 4);
    assert.equal(overview.timeline[0].status, 'SAFE_OPEN');
    assert.equal(overview.timeline[1].status, 'SAFE_OPEN');
    // AQI 55 > sensitive threshold 45 -> BRIEF_PURGE
    assert.equal(overview.timeline[2].status, 'BRIEF_PURGE');
    // AQI 85 > sensitive moderate threshold 75 -> KEEP_SEALED
    assert.equal(overview.timeline[3].status, 'KEEP_SEALED');
    assert.equal(overview.bestVentilationWindow.hasSafeWindow, true);
    assert.equal(overview.bestVentilationWindow.avgAqi, 34);
  });

  it('uses general threshold (65) when household has no high-risk respiratory vulnerabilities', () => {
    const overview = buildAirQualityOverviewFromRaw({
      lat: 37.7599,
      lng: -122.4148,
      vulnerabilities: ['OUTDOOR_ATHLETE'],
      nowIso: '2026-11-24T12:00:00Z',
      openMeteoData: {
        current: { us_aqi: 55, pm2_5: 14.0, us_aqi_pm2_5: 55 },
        hourly: {
          time: ['2026-11-24T12:00'],
          us_aqi: [55],
          us_aqi_pm2_5: [55],
        },
      },
      weatherCurr: null,
      weatherHourly: null,
    });

    assert.equal(overview.sensitivityThresholdAqi, 65);
    assert.equal(overview.timeline[0].status, 'SAFE_OPEN');
  });
});

describe('Snap-a-Room IAQ Response Sanitization (sanitizeRoomScanResponse)', () => {
  it('enforces firebase-blueprint volumetric limits and defaults invalid enums safely', () => {
    const raw = {
      overallRiskLevel: 'INVALID_LEVEL',
      roomSummary: 'S'.repeat(800),
      ventilationAdvice: 'V'.repeat(800),
      detectedRisks: Array.from({ length: 9 }, (_, i) => ({
        source: `Source ${i}`,
        pollutantType: 'NO2',
        severity: 'HIGH',
        explanation: 'Gas burner emissions.',
      })),
      hacks: Array.from({ length: 5 }, (_, i) => ({
        id: `hack-${i + 1}`,
        title: `Hack ${i + 1}`,
        costTier: i === 0 ? 'Zero Cost' : 'UNKNOWN_TIER',
        estimatedImpact: '-40% NO2',
        steps: 'Open back window 10 cm while cooking.',
        whyItWorks: 'Creates cross-draft exhaust.',
      })),
    };

    const sanitized = sanitizeRoomScanResponse(raw, 'KITCHEN', 620);
    assert.equal(sanitized.roomType, 'KITCHEN');
    assert.equal(sanitized.overallRiskLevel, 'MODERATE');
    assert.equal(sanitized.roomSummary.length, 580);
    assert.equal(sanitized.ventilationAdvice.length, 580);
    assert.equal(sanitized.outdoorAqiAtScan, 500);
    assert.equal(sanitized.detectedRisks.length, 6);
    assert.equal(sanitized.hacks.length, 3);
    assert.equal(sanitized.hacks[1].costTier, 'Zero Cost');

    const prompt = buildRoomScanPrompt({
      roomType: 'KITCHEN',
      outdoorAqi: 42,
      dominantPollutant: 'PM2.5',
      familyProfile: { vulnerabilities: ['ASTHMA_COPD'], cookingSetup: 'GAS_STOVE' },
    });
    assert.ok(prompt.includes('ASTHMA_COPD'));
  });
});

describe('Commute Swap & EPA Emission Impact Engine (computeCommuteLegImpact)', () => {
  const sampleDest = {
    name: 'Neighborhood Market',
    address: '123 Valencia St',
    lat: 37.765,
    lng: -122.421,
  };

  it('recommends WALK for short car trips (<= 1.8 km) in clean air and computes CO2/NOx/PM2.5 savings', () => {
    const leg = computeCommuteLegImpact({
      item: {
        id: 'stop-1',
        time: '09:00 AM',
        title: 'Morning Errand',
        currentMode: 'DRIVE',
      },
      idx: 0,
      destPlace: sampleDest,
      vehicleEmissionType: 'GASOLINE',
      currentAqi: 38,
      driveRoute: {
        mode: 'DRIVE',
        distanceMeters: 1500,
        durationSeconds: 360,
        encodedPolyline: 'poly_drive',
        fuelMicroliters: 140000,
        ecoDistanceMeters: 1500,
        ecoDurationSeconds: 360,
        ecoFuelMicroliters: 130000,
        ecoPolyline: 'poly_eco',
      },
      transitRoute: null,
      bikeRoute: null,
      walkRoute: {
        mode: 'WALK',
        distanceMeters: 1400,
        durationSeconds: 1020,
        encodedPolyline: 'poly_walk',
        fuelMicroliters: 0,
        ecoDistanceMeters: 1400,
        ecoDurationSeconds: 1020,
        ecoFuelMicroliters: 0,
        ecoPolyline: 'poly_walk',
      },
      nearbyTransitOrPark: null,
    });

    assert.equal(leg.recommendedMode, 'WALK');
    assert.equal(leg.distanceKm, 1.5);
    // 215 g/km * 1.5 km = 323 g CO2 saved
    assert.equal(leg.communityCo2GramsSaved, 323);
    // 180 mg/km * 1.5 km = 270 mg NOx saved
    assert.equal(leg.communityNoxMgSaved, 270);
    assert.ok(leg.personalPm25ReductionPct >= 12);
    assert.ok(leg.personalPm25UgSaved >= 0.6);

    const merged = mergeSwapsWithGeminiAdvice(
      [leg],
      {
        planTitle: 'Mission Clean-Air Plan',
        legAdvice: [
          {
            id: 'stop-1',
            recommendedTimeWindow: 'Leave at 8:45 AM',
            swapHeadline: 'Walk via greenway instead of driving',
            swapRationale: 'Eliminates 323g of tailpipe CO2.',
          },
        ],
      },
      'Mission District'
    );

    assert.equal(merged.planTitle, 'Mission Clean-Air Plan');
    assert.equal(merged.communityCo2GramsSaved, 323);
    assert.equal(merged.swaps[0].swapHeadline, 'Walk via greenway instead of driving');

    const prompt = buildRoutinePlanPrompt({
      validLegs: [leg],
      vulnerabilities: ['ASTHMA_COPD'],
      hourlyForecast: [{ localHourLabel: '9 AM', usAqi: 38, status: 'SAFE_OPEN' }],
      currentAqi: 38,
    });
    assert.ok(prompt.includes('Neighborhood Market'));
  });
});
