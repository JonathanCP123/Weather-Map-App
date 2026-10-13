import type { LatLngLike } from './types';

export const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

export const DEFAULT_CENTER: LatLngLike = { lat: -36.8485, lng: 174.7633 }; // Auckland: used when nothing better is known
export const START_ZOOM = 12;
export const MY_LOCATION_LABEL = 'My location';

/** True on phone-sized screens (matches the CSS breakpoint). */
export const isPhone = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches;
