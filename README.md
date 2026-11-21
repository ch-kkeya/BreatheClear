# BreatheClear — Air Quality Assistant

BreatheClear is a mobile-first full-stack web application that helps urban households reduce daily pollution exposure and lower community emissions. It combines live hyper-local air quality and weather telemetry, AI-powered indoor room scanning, low-emission commute planning, and Firebase-backed household profiles.

## Features

- **Family Profile (Firebase Auth + Firestore)**
  - Configure home neighborhood (with Google Places Autocomplete or browser geolocation), household vulnerabilities (asthma/COPD, young children, seniors 65+, pregnancy, cardiovascular sensitivity, outdoor athletes), primary commute mode, vehicle emission type, and home cooking/ventilation setup.
  - Persists profiles, room scans, and routine plans per signed-in Google account with owner-scoped Firestore security rules.

- **Live 500m Hyper-Local Air Quality & Smog Map**
  - Interactive Google Map with a 500m radius zone, tap-anywhere coordinate sampling, and toggleable overlay modes (`US AQI`, `PM2.5`, `Clean Map`).
  - Live **Open-Meteo Air Quality API (Copernicus CAMS)** readings for US EPA AQI, exact dominant pollutant, and 6 measured pollutants (`PM2.5`, `PM10`, `O₃`, `NO₂`, `SO₂`, `CO`) merged hour-by-hour with the **Google Weather API**.
  - Personalized **24-Hour Safe Ventilation Window** timeline (`Open Windows`, `Brief Purge`, `Keep Sealed`) calibrated to household sensitivity thresholds.

- **Snap-a-Room IAQ Scanner**
  - Upload or capture a photo of a kitchen, bedroom, living room, or window (or test with built-in sample room photos).
  - Server-side Gemini Vision analyzes visible indoor air quality risks and returns **3 zero-cost or low-cost IAQ hacks** with checkable progress synced to Firestore.

- **Daily Routine & Impact Planner**
  - Edit a daily schedule of stops and compare baseline commutes against low-emission alternatives using the **Google Maps Routes API** (including eco-friendly driving, transit, cycling, and walking), **Places API (New)**, and **Gemini**.
  - Displays a live **Direct Impact Card** quantifying both personal inhaled PM2.5 reduction (`%` and `µg/day`) and community emissions avoided (`kg CO₂e/day` and `g NOₓ/day`), alongside an interactive route comparison map.

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, `@vis.gl/react-google-maps`, `lucide-react`, `motion`
- **Backend:** Node.js, Express (`server.ts`), Vite 8 middleware (dev) / static bundle (prod)
- **AI:** `@google/genai` (server-side only)
- **Database & Auth:** Firebase Authentication (Google Sign-In) & Cloud Firestore
- **Location, Weather & Air Quality:** Google Maps JavaScript API, Places API (New), Routes API, Weather API, and Open-Meteo Air Quality API

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and populate the required keys:

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `GEMINI_API_KEY` | Server-side Gemini API key (never exposed to the browser) |
| `GOOGLE_MAPS_API_KEY` | Google Maps Platform key for Weather, Places (New), and Routes APIs |
| `VITE_GOOGLE_MAPS_API_KEY` | Public browser key for Maps JavaScript API (falls back to `/api/config`) |
| `APP_URL` | Base URL where the app is hosted |

> **Note:** Air quality readings use the free Open-Meteo Air Quality API (no key required), while Maps, Weather, Places, and Routes use your Google Maps Platform key.

### 3. Firebase Configuration

Firebase client config is stored in `firebase-applet-config.json`, with the data model documented in `firebase-blueprint.json` and security rules defined in `firestore.rules`.

### 4. Run Locally

Start the full-stack development server (Express + Vite middleware on port `3000`):

```bash
npm run dev
```

### 5. Build, Lint & Production Start

```bash
# Type-check TypeScript
npm run lint

# Lint Firestore security rules
npx eslint firestore.rules

# Build production client bundle
npm run build

# Start production server
NODE_ENV=production npm start
```

## Server API Endpoints

| Method & Path | Purpose |
| --- | --- |
| `GET /api/config` | Returns public runtime Maps configuration (never exposes `GEMINI_API_KEY`) |
| `POST /api/air-quality/overview` | Fetches Open-Meteo AQI + Google Weather current/hourly data and builds the 24h Safe Ventilation Window |
| `GET /api/air-quality/tile/:mapType/:z/:x/:y` | Proxies Google Air Quality heatmap tiles with solution attribution headers |
| `POST /api/places/search` | Proxies Google Places API (New) Text Search with location biasing |
| `POST /api/iaq/scan` | Runs server-side Gemini Vision IAQ room analysis and returns 3 low-cost hacks |
| `POST /api/routine/plan` | Computes low-emission commute swaps via Google Places, Routes, and Gemini |

## Project Structure

```text
├── server.ts                    # Express API server & Vite middleware entry point
├── index.html                   # HTML shell & typography imports
├── firestore.rules              # Owner-scoped Firestore security rules
├── firebase-blueprint.json      # Firestore collection & schema specification
├── src/
│   ├── App.tsx                  # Root layout, navigation, auth & Firestore sync
│   ├── types.ts                 # Shared TypeScript interfaces & defaults
│   ├── lib/
│   │   ├── firebase.ts          # Firebase Auth & Firestore helpers
│   │   └── aqiUtils.ts          # AQI color/label scales, fetch wrapper, polyline decoder
│   └── components/
│       ├── HyperLocalAirMap.tsx       # 500m AQI map, weather & Safe Ventilation timeline
│       ├── RoomIaqScanner.tsx         # Photo capture/upload & Gemini IAQ hacks
│       ├── RoutineImpactPlanner.tsx   # Schedule editor, route comparison & Direct Impact Card
│       ├── FamilyProfileForm.tsx      # Household vulnerability & home setup form
│       ├── PlaceSearchInput.tsx       # Google Places Autocomplete input
│       └── ErrorBoundary.tsx          # React error boundary
```
