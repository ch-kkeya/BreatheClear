import type { RiskLevel, VulnerabilityId } from '../types';
import { handleClientApiFallback } from './clientApiFallback';

export interface AqiTone {
  label: string;
  shortLabel: string;
  textClass: string;
  bgSoftClass: string;
  ringColor: string;
  barClass: string;
}

export function getAqiTone(usAqi: number): AqiTone {
  if (usAqi <= 50) {
    return {
      label: 'Good Air Quality',
      shortLabel: 'Good',
      textClass: 'text-emerald-800',
      bgSoftClass: 'bg-emerald-50/90',
      ringColor: '#15803D',
      barClass: 'bg-emerald-600',
    };
  }
  if (usAqi <= 100) {
    return {
      label: 'Moderate Air Quality',
      shortLabel: 'Moderate',
      textClass: 'text-amber-800',
      bgSoftClass: 'bg-amber-50/90',
      ringColor: '#B45309',
      barClass: 'bg-amber-600',
    };
  }
  if (usAqi <= 150) {
    return {
      label: 'Unhealthy for Sensitive Groups',
      shortLabel: 'Sensitive',
      textClass: 'text-orange-800',
      bgSoftClass: 'bg-orange-50/90',
      ringColor: '#C2410C',
      barClass: 'bg-orange-600',
    };
  }
  return {
    label: 'Unhealthy Air Quality',
    shortLabel: 'Unhealthy',
    textClass: 'text-red-800',
    bgSoftClass: 'bg-red-50/90',
    ringColor: '#B91C1C',
    barClass: 'bg-red-600',
  };
}

export function getRiskTone(level: RiskLevel): { label: string; textClass: string; bgClass: string } {
  switch (level) {
    case 'LOW':
      return { label: 'Low Risk', textClass: 'text-emerald-800', bgClass: 'bg-emerald-50' };
    case 'MODERATE':
      return { label: 'Moderate Risk', textClass: 'text-amber-800', bgClass: 'bg-amber-50' };
    case 'ELEVATED':
      return { label: 'Elevated Risk', textClass: 'text-orange-800', bgClass: 'bg-orange-50' };
    case 'HIGH':
      return { label: 'High Risk', textClass: 'text-red-800', bgClass: 'bg-red-50' };
  }
}

export const VULNERABILITY_LABELS: Record<VulnerabilityId, string> = {
  ASTHMA_COPD: 'Asthma / COPD',
  YOUNG_CHILDREN: 'Young Children',
  SENIORS_65: 'Older Adults (65+)',
  PREGNANCY: 'Pregnancy',
  CARDIOVASCULAR: 'Heart Sensitivity',
  OUTDOOR_ATHLETE: 'Outdoor Runners',
};

/**
 * Tier 2 Demo Key Quota Defense: wraps fetch to detect 429 / RESOURCE_EXHAUSTED
 * and trigger the global non-intrusive quota banner event.
 */
export async function apiFetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    if (url.startsWith('/api/')) {
      return handleClientApiFallback<T>(url, options);
    }
    throw new Error('Network error');
  }
  const text = await response.text();
  const isHtml = /^\s*<(!doctype|html)/i.test(text);
  if (url.startsWith('/api/') && (isHtml || response.status === 404 || response.status === 405)) {
    return handleClientApiFallback<T>(url, options);
  }
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {
      error: isHtml
        ? `Service request was blocked (HTTP ${response.status}).`
        : text || `Request failed (${response.status})`,
    };
  }

  if (
    response.status === 429 ||
    parsed?.quotaExceeded === true ||
    parsed?.error?.status === 'RESOURCE_EXHAUSTED' ||
    String(parsed?.error || '').includes('RESOURCE_EXHAUSTED')
  ) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }

  if (!response.ok) {
    throw new Error(parsed?.error || `Request failed (${response.status})`);
  }

  return parsed as T;
}

/**
 * Decodes a Google Routes API encoded polyline into LatLng literal points.
 */
export function decodePolyline(encoded: string): Array<{ lat: number; lng: number }> {
  if (!encoded) return [];
  const points: Array<{ lat: number; lng: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/**
 * Compresses any uploaded photo or sample URL to <= 1200px JPEG base64 for fast Gemini Vision scanning.
 */
export function imageSourceToCompressedBase64(
  source: File | string
): Promise<{ base64: string; mimeType: 'image/jpeg'; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const cleanupObjectUrl = (url: string) => {
      if (typeof source !== 'string') {
        URL.revokeObjectURL(url);
      }
    };

    const srcUrl = typeof source === 'string' ? source : URL.createObjectURL(source);

    img.onload = () => {
      try {
        const maxDim = 1200;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
        const base64 = dataUrl.split(',')[1] || '';
        cleanupObjectUrl(srcUrl);
        resolve({ base64, mimeType: 'image/jpeg', previewUrl: dataUrl });
      } catch (err) {
        cleanupObjectUrl(srcUrl);
        reject(err);
      }
    };

    img.onerror = () => {
      cleanupObjectUrl(srcUrl);
      reject(new Error('Could not load the selected image.'));
    };

    img.src = srcUrl;
  });
}
