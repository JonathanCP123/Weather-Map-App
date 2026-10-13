// Finding the user's position: precise (browser geolocation) and rough (IP lookup).

import type { LatLngLike } from '../types';
import { DEFAULT_CENTER } from '../constants';

/**
 * Asks the browser for the precise position. This triggers the browser's permission
 * prompt, so only call it from a user tap (the "locate me" buttons).
 * Rejects with a GeolocationPositionError-like object ({ code: 1 | 2 | 3 }), or { code: 0 }
 * when the browser has no geolocation support.
 */
export const requestPosition = (timeoutMs = 10000): Promise<LatLngLike> =>
  new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject({ code: 0 });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 }
    );
  });

export const geolocationErrorMessage = (err: any): string => {
  switch (err && err.code) {
    case 0:
      return 'Your browser does not support location.';
    case 1:
      return 'Location is blocked. Allow it for this site in your browser settings, then try again.';
    case 2:
      return 'Your location is unavailable right now. Try again in a moment.';
    case 3:
      return 'Finding your location took too long. Try again.';
    default:
      return 'Could not get your location.';
  }
};

const APPROX_CACHE_KEY = 'approxLocation';
const APPROX_CACHE_MS = 12 * 60 * 60 * 1000;

const readCachedApprox = (): LatLngLike | null => {
  try {
    const raw = localStorage.getItem(APPROX_CACHE_KEY);
    if (!raw) return null;
    const { lat, lng, at } = JSON.parse(raw);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Date.now() - at < APPROX_CACHE_MS) {
      return { lat, lng };
    }
  } catch {
    /* storage blocked or corrupt: ignore */
  }
  return null;
};

const writeCachedApprox = (pos: LatLngLike) => {
  try {
    localStorage.setItem(APPROX_CACHE_KEY, JSON.stringify({ ...pos, at: Date.now() }));
  } catch {
    /* storage blocked: ignore */
  }
};

/**
 * Rough, city-level position from the visitor's IP address. No permission prompt.
 * The free ipwho.is endpoint allows 1,000 requests/day per website (shared by all
 * visitors), which is why the result is cached. Returns null on any failure.
 */
const fetchApproxLocation = async (timeoutMs: number): Promise<LatLngLike | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://ipwho.is/', { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.success !== false && Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
      return { lat: data.latitude, lng: data.longitude };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Where the map should open, best source first:
 *  1. the precise position, but ONLY if the user has already allowed location for this
 *     site (so there is never a surprise permission prompt on page load);
 *  2. a recent rough position remembered from an earlier visit;
 *  3. a fresh rough (city-level) position from the IP address;
 *  4. Auckland.
 */
export const getStartingCenter = async (): Promise<LatLngLike> => {
  try {
    const perm = await (navigator as any).permissions?.query({ name: 'geolocation' });
    if (perm && perm.state === 'granted') {
      try {
        return await requestPosition(3000);
      } catch {
        /* fall through to the rough location */
      }
    }
  } catch {
    /* Permissions API not available: fall through */
  }
  const cached = readCachedApprox();
  if (cached) return cached;
  const approx = await fetchApproxLocation(2500);
  if (approx) {
    writeCachedApprox(approx);
    return approx;
  }
  return DEFAULT_CENTER;
};
