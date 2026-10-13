// Shared types used across the app.

export interface PlaceInfo {
  id?: string;
  name: string;
  address: string;
  mapsUri?: string;
  accessibility: boolean | null;
}

export interface RouteSummary {
  modeIcon: string;
  duration: string;
  distance: string;
}

export type LatLngLike = { lat: number; lng: number };

// The card HTML uses inline onclick="window.showPlaceCard()" handlers, so these
// functions are put on `window` by App.
declare global {
  interface Window {
    showPlaceCard: () => void;
    showWeatherCard: () => void;
  }
}
