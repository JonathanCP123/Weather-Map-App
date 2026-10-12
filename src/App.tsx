import React, { useEffect, useRef, useState } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import './styles.css';

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

interface PlaceInfo {
  id?: string;
  name: string;
  address: string;
  mapsUri?: string;
  accessibility: boolean | null;
}

interface RouteSummary {
  modeIcon: string;
  duration: string;
  distance: string;
}

declare global {
  interface Window {
    showPlaceCard: () => void;
    showWeatherCard: () => void;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers. They use no component state, so they live outside the component
// instead of being re-created on every render.
// ---------------------------------------------------------------------------

/** True on phone-sized screens (matches the CSS breakpoint). */
const isPhone = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches;

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------
type LatLngLike = { lat: number; lng: number };

const DEFAULT_CENTER: LatLngLike = { lat: -36.8485, lng: 174.7633 }; // Auckland: used when nothing better is known
const START_ZOOM = 12;
const MY_LOCATION_LABEL = 'My location';

// ---------------------------------------------------------------------------
// Card size vs. zoom: the card is a fixed number of pixels, so when the map is
// zoomed out it would cover more and more of it. Instead:
//   zoom >= CARD_FULL_MIN_ZOOM        full size
//   zoom >= CARD_HIDE_BELOW_ZOOM      slightly smaller ("compact")
//   below that                        card tucked away (the weather pin stays);
//                                     it comes back when you zoom in again.
// Change these two numbers to taste (bigger number = the card shrinks/hides sooner).
// ---------------------------------------------------------------------------
const CARD_FULL_MIN_ZOOM = 12;
const CARD_HIDE_BELOW_ZOOM = 10;
type CardBand = 'full' | 'compact' | 'hidden';
const cardBandForZoom = (zoom: number): CardBand =>
  zoom >= CARD_FULL_MIN_ZOOM ? 'full' : zoom >= CARD_HIDE_BELOW_ZOOM ? 'compact' : 'hidden';

/**
 * Asks the browser for the precise position. This triggers the browser's permission
 * prompt, so only call it from a user tap (the "locate me" buttons).
 * Rejects with a GeolocationPositionError-like object ({ code: 1 | 2 | 3 }), or { code: 0 }
 * when the browser has no geolocation support.
 */
const requestPosition = (timeoutMs = 10000): Promise<LatLngLike> =>
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

const geolocationErrorMessage = (err: any): string => {
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
const APPROX_CACHE_MS = 12 * 60 * 60 * 1000; // remember the rough location for 12 hours

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
const getStartingCenter = async (): Promise<LatLngLike> => {
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

/** Resolves with `fallback` if `promise` is slow or fails, so the map is never held up. */
const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });

/** Crosshair icon used by both "locate me" buttons. */
const LocateIcon: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** Escapes text before it is placed inside an HTML string (InfoWindow content, innerHTML). */
const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Maps an Open-Meteo WMO weather code to an emoji. */
const getWeatherIcon = (code: number, rain: number, isDay = 1): string => {
  const day = isDay === 1;
  if (code === 0) return day ? '☀️' : '🌙'; // clear sky
  if (code === 1) return day ? '🌤️' : '🌙'; // mainly clear
  if (code === 2) return day ? '⛅' : '☁️'; // partly cloudy
  if (code === 3) return '☁️'; // overcast
  if (code === 45 || code === 48) return '🌫️'; // fog / rime fog
  if (code >= 51 && code <= 57) return '🌦️'; // drizzle (incl. freezing)
  if (code >= 61 && code <= 67) return '🌧️'; // rain (incl. freezing)
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄️'; // snow
  if (code >= 80 && code <= 82) return '🌧️'; // rain showers
  if (code >= 95 && code <= 99) return '⛈️'; // thunderstorm (incl. hail)
  // Unknown code: fall back on the measured precipitation.
  return rain > 0 ? '🌧️' : '☁️';
};

const formatHourString = (isoStr: string): string => {
  if (!isoStr || !isoStr.includes('T')) return '';
  const hour = parseInt(isoStr.split('T')[1].split(':')[0], 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${ampm}`;
};

/**
 * Index of the hourly entry for the CURRENT hour.
 * Open-Meteo's current.time is usually on a 15-minute step (e.g. "2026-10-12T14:15")
 * while hourly times are on the hour ("...T14:00"), so we compare "YYYY-MM-DDTHH" only.
 */
const findCurrentHourIndex = (hourlyTimes: string[], currentTime: string): number => {
  if (!hourlyTimes || !currentTime) return 0;
  const currentHour = currentTime.slice(0, 13);
  const idx = hourlyTimes.findIndex((t) => t.slice(0, 13) === currentHour);
  return idx === -1 ? 0 : idx;
};

export const App: React.FC = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);

  // Control State
  const [showWeather, setShowWeather] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [routeOrigin, setRouteOrigin] = useState<string>('');
  const [routeDestination, setRouteDestination] = useState<string>('');
  const [routeMode, setRouteMode] = useState<string>('DRIVING');
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [isSatellite, setIsSatellite] = useState<boolean>(false);
  // Collapsible controls panel: collapsed by default on phones so the map stays visible,
  // open by default on desktop. The user can toggle it on both.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => !isPhone());
  // Auto-fold after a tap/search/route, but only on phones (on desktop the panel stays as you left it).
  const foldPanelOnPhone = () => { if (isPhone()) setPanelOpen(false); };

  // "Locate me" state
  const [locating, setLocating] = useState<boolean>(false); // map button busy
  const [originLocating, setOriginLocating] = useState<boolean>(false); // origin-field button busy
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  // Exact coordinates behind the "My location" text in the Origin field
  const originCoordsRef = useRef<LatLngLike | null>(null);

  // References to Google Libraries and Services
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const activeMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(null);
  const directionsRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const placesServiceRef = useRef<google.maps.places.PlacesService | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const placesLibRef = useRef<google.maps.PlacesLibrary | null>(null);
  const markerLibRef = useRef<google.maps.MarkerLibrary | null>(null);

  // Global InfoWindow Toggle Memory
  const currentPlaceInfoRef = useRef<PlaceInfo | null>(null);
  const currentWeatherDataRef = useRef<any>(null);
  const weatherLayerVisibleRef = useRef<boolean>(true);

  // Which card is showing, which pin it belongs to, and the zoom-based size state
  const currentCardRef = useRef<'place' | 'weather'>('place');
  const currentMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const cardBandRef = useRef<CardBand>('full');
  const cardHiddenByZoomRef = useRef<boolean>(false); // true = we hid the card because of zoom, so bring it back later
  const infoOpenRef = useRef<boolean>(false); // is the InfoWindow currently open?

  // Stale-request guard (see clearMarkers): the generation counter changes every time
  // the pins are cleared; the AbortController cancels the in-flight weather request.
  const markerGenerationRef = useRef<number>(0);
  const weatherAbortRef = useRef<AbortController | null>(null);

  // Helpers
  // (getWeatherIcon, formatHourString, findCurrentHourIndex and escapeHtml are now
  //  plain functions at the top of this file; they do not need component state.)

  // Removes every pin AND invalidates anything still in flight. Each call bumps the
  // "generation" counter, cancels the pending weather request and returns the new
  // generation number. Async work (weather fetch, place lookup, reverse geocode)
  // remembers the generation it started in and throws its result away if the counter
  // has moved on, i.e. the user clicked / searched / routed again in the meantime.
  const clearMarkers = (): number => {
    markerGenerationRef.current += 1;
    cardHiddenByZoomRef.current = false;
    currentMarkerRef.current = null;
    if (weatherAbortRef.current) {
      weatherAbortRef.current.abort();
      weatherAbortRef.current = null;
    }
    activeMarkersRef.current.forEach((m) => (m.map = null));
    activeMarkersRef.current = [];
    return markerGenerationRef.current;
  };

  const fetchDetailedWeather = async (lat: number, lng: number, signal?: AbortSignal) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,weather_code,precipitation,is_day&timezone=auto`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Weather fetch failed');
    return await response.json();
  };

  // Card HTML Renderers
  const renderPlaceCardHTML = (placeInfo: PlaceInfo): string => {
    let accText = 'Accessibility status unknown';
    let accIcon = '♿';
    if (placeInfo.accessibility === true) {
      accText = 'Accessible entrance';
      accIcon = '♿';
    } else if (placeInfo.accessibility === false) {
      accText = 'No accessible entrance';
      accIcon = '🚫';
    }

    const mapsLink = placeInfo.mapsUri
      ? placeInfo.mapsUri
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeInfo.name + ' ' + placeInfo.address)}`;

    return `
      <div class="place-card-popup ${cardBandRef.current === 'full' ? '' : 'card-compact'}">
          <div class="place-card-header">
              <h3 class="place-card-title">${escapeHtml(placeInfo.name)}</h3>
              <a href="${escapeHtml(mapsLink)}" target="_blank" rel="noopener noreferrer" class="place-card-link-btn" title="Open in Google Maps">↗</a>
          </div>
          ${placeInfo.address ? `<div class="place-card-address">${escapeHtml(placeInfo.address)}</div>` : ''}
          <div class="place-card-acc-row">
              <span class="acc-icon">${accIcon}</span>
              <span>${accText}</span>
          </div>
          <div class="view-weather-btn-link" onclick="window.showWeatherCard()">View Weather Forecast ⛅</div>
      </div>
    `;
  };

  const renderWeatherCardHTML = (placeInfo: PlaceInfo, weatherData: any): string => {
    const current = weatherData.current;
    const temp = Math.round(current.temperature_2m);
    const hourly = weatherData.hourly;

    let accessibilityHTML = '';
    if (placeInfo.accessibility === true) {
      accessibilityHTML = `<div class="accessibility-badge accessible">♿ Accessible entrance</div>`;
    } else if (placeInfo.accessibility === false) {
      accessibilityHTML = `<div class="accessibility-badge inaccessible">🚫 No accessible entrance</div>`;
    } else {
      accessibilityHTML = `<div class="accessibility-badge unknown">♿ Accessibility status unknown</div>`;
    }

    let hourlyHTML = '';
    const startIdx = hourly && hourly.time ? findCurrentHourIndex(hourly.time, current.time) : 0;
    const hourlyCount = hourly && hourly.time ? hourly.time.length : 0;

    for (let i = startIdx; i < startIdx + 5 && i < hourlyCount; i++) {
      const timeLabel = i === startIdx ? 'Now' : formatHourString(hourly.time[i]);
      const hTemp = Math.round(hourly.temperature_2m[i]);
      const hCode = hourly.weather_code[i];
      const hRain = hourly.precipitation[i];
      const hIsDay = hourly.is_day[i];
      const hIcon = getWeatherIcon(hCode, hRain, hIsDay);

      hourlyHTML += `
          <div class="hourly-card">
              <div class="time">${timeLabel}</div>
              <div class="icon">${hIcon}</div>
              <div class="temp">${hTemp}°C</div>
          </div>
      `;
    }

    return `
      <div class="unified-popup ${cardBandRef.current === 'full' ? '' : 'card-compact'}">
          <div class="place-header">
              <div class="back-to-place-btn" onclick="window.showPlaceCard()">← Back to Place Info</div>
              <h3>📍 Destination: ${escapeHtml(placeInfo.name)}</h3>
              ${placeInfo.address ? `<p>${escapeHtml(placeInfo.address)}</p>` : ''}
              ${accessibilityHTML}
          </div>
          
          <div class="weather-section-title">Current Weather</div>
          <div class="weather-details-grid">
              <div><b>Temp:</b> ${temp}°C</div>
              <div><b>Wind:</b> ${current.wind_speed_10m} km/h</div>
              <div><b>Humidity:</b> ${current.relative_humidity_2m}%</div>
              <div><b>Rain:</b> ${current.precipitation} mm</div>
          </div>

          <div class="weather-section-title">5-Hour Forecast</div>
          <div class="hourly-container">${hourlyHTML}</div>
      </div>
    `;
  };

  // Mount Window Functions for Inline Onclick Events
  useEffect(() => {
    window.showPlaceCard = () => {
      if (currentPlaceInfoRef.current && infoWindowRef.current) {
        currentCardRef.current = 'place';
        infoWindowRef.current.setContent(renderPlaceCardHTML(currentPlaceInfoRef.current));
      }
    };

    window.showWeatherCard = () => {
      if (currentPlaceInfoRef.current && currentWeatherDataRef.current && infoWindowRef.current) {
        currentCardRef.current = 'weather';
        infoWindowRef.current.setContent(
          renderWeatherCardHTML(currentPlaceInfoRef.current, currentWeatherDataRef.current)
        );
      }
    };
  }, []);

  // Fetch Place Details
  const getPlaceDetails = async (placeId: string): Promise<PlaceInfo | null> => {
    try {
      if (!placesLibRef.current) return null;
      const place = new placesLibRef.current.Place({ id: placeId });

      await place.fetchFields({
        fields: ['displayName', 'formattedAddress', 'accessibilityOptions', 'googleMapsURI'],
      });

      // Extract Name
      let name = "Selected Location";
      const dn = place.displayName as any;
      if (dn) {
        name = typeof dn === 'string' ? dn : dn.text || "Selected Location";
      }

      let isAccessible: boolean | null = null;
      if (
        place.accessibilityOptions &&
        place.accessibilityOptions.hasWheelchairAccessibleEntrance !== undefined &&
        place.accessibilityOptions.hasWheelchairAccessibleEntrance !== null
      ) {
        isAccessible = place.accessibilityOptions.hasWheelchairAccessibleEntrance;
      }

      return {
        id: placeId,
        name: name,
        address: place.formattedAddress || '',
        mapsUri: place.googleMapsURI || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
        accessibility: isAccessible,
      };
    } catch (err) {
      console.warn('Place fetchFields failed, using PlacesService fallback', err);
      return new Promise((resolve) => {
        if (!placesServiceRef.current) return resolve(null);
        placesServiceRef.current.getDetails(
          { placeId: placeId, fields: ['name', 'formatted_address', 'url'] },
          (place, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && place) {
              resolve({
                id: placeId,
                name: place.name || 'Selected Location',
                address: place.formatted_address || '',
                mapsUri: place.url || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
                accessibility: null,
              });
            } else {
              resolve(null);
            }
          }
        );
      });
    }
  };

  // Reverse Geocode
  const handleGeocodeFallback = (
    latLng: google.maps.LatLng,
    targetMap: google.maps.Map,
    generation: number = markerGenerationRef.current
  ) => {
    if (!geocoderRef.current) return;
    geocoderRef.current.geocode({ location: latLng }, (results, status) => {
      // A newer click/search/route took over while Google was answering.
      if (generation !== markerGenerationRef.current) return;
      let placeInfo: PlaceInfo = {
        name: 'Selected Location',
        address: '',
        mapsUri: `https://www.google.com/maps/search/?api=1&query=${latLng.lat()},${latLng.lng()}`,
        accessibility: null,
      };

      if (status === 'OK' && results && results[0]) {
        const topResult = results[0];
        placeInfo.address = topResult.formatted_address;

        const street = topResult.address_components.find((c) => c.types.includes('route'));
        const area = topResult.address_components.find(
          (c) => c.types.includes('sublocality') || c.types.includes('locality')
        );

        if (street) {
          placeInfo.name = street.long_name;
        } else if (area) {
          placeInfo.name = area.long_name;
        } else {
          placeInfo.name = topResult.address_components[0].long_name;
        }
      }

      createWeatherMarker(latLng, placeInfo, targetMap, true, generation);
    });
  };

  // Create Weather Marker Pin
  const createWeatherMarker = async (
    position: google.maps.LatLng | google.maps.LatLngLiteral,
    placeInfo: PlaceInfo,
    targetMap: google.maps.Map,
    autoOpen = true,
    // Which "generation" of markers this request belongs to (see clearMarkers).
    generation: number = markerGenerationRef.current
  ) => {
    if (!markerLibRef.current || !infoWindowRef.current) return;
    if (generation !== markerGenerationRef.current) return; // already superseded

    const markerDiv = document.createElement('div');
    markerDiv.className = 'weather-marker';
    markerDiv.innerText = '⏳ Loading...';

    const marker = new markerLibRef.current.AdvancedMarkerElement({
      map: targetMap,
      position: position,
      content: markerDiv,
    });

    activeMarkersRef.current.push(marker);
    currentMarkerRef.current = marker;

    const lat = typeof position.lat === 'function' ? position.lat() : position.lat;
    const lng = typeof position.lng === 'function' ? position.lng() : position.lng;

    // clearMarkers() aborts this request if the user clicks/searches/routes again.
    const controller = new AbortController();
    weatherAbortRef.current = controller;

    try {
      const weatherData = await fetchDetailedWeather(lat, lng, controller.signal);

      // Stale-response guard: the pin was removed while we were waiting, so do not
      // touch the shared refs or reopen the InfoWindow for it.
      if (generation !== markerGenerationRef.current) return;

      const current = weatherData.current;
      const temp = Math.round(current.temperature_2m);
      const currentIcon = getWeatherIcon(current.weather_code, current.precipitation, current.is_day);

      markerDiv.innerHTML = `${temp}°C ${currentIcon} <span style="font-size: 11px; color: #1a73e8;">ℹ️</span>`;

      currentPlaceInfoRef.current = placeInfo;
      currentWeatherDataRef.current = weatherData;

      markerDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        currentPlaceInfoRef.current = placeInfo;
        currentWeatherDataRef.current = weatherData;
        cardHiddenByZoomRef.current = false; // the user opened it on purpose
        window.showWeatherCard();
        if (infoWindowRef.current) infoWindowRef.current.open(targetMap, marker);
      });

      // Do not pop the card open on a pin that is hidden because the checkbox was
      // unticked while the weather was still loading.
      if (autoOpen && weatherLayerVisibleRef.current) {
        if (cardBandRef.current === 'hidden') {
          // Zoomed too far out for a card: show it when the user zooms back in.
          currentCardRef.current = 'place';
          cardHiddenByZoomRef.current = true;
        } else {
          window.showPlaceCard();
          infoWindowRef.current.open(targetMap, marker);
        }
      }
    } catch (err: any) {
      // An aborted request or a superseded pin is expected, not an error.
      if (err?.name === 'AbortError' || generation !== markerGenerationRef.current) return;
      console.error('Weather error:', err);
      markerDiv.innerText = '⚠️ N/A';
    }
  };

  // Initialize Map
  useEffect(() => {
    // React StrictMode (development only) runs every effect twice: mount -> cleanup -> mount.
    // `cancelled` lets the abandoned first run stop before it builds a second map, and
    // `created` lets the cleanup reach the map that the async code below creates.
    let cancelled = false;

    // Work out where to open the map WHILE the Google libraries load, so it adds no waiting.
    // Never rejects and gives up after 3.5s, falling back to Auckland.
    const startCenterPromise = withTimeout(getStartingCenter(), 3500, DEFAULT_CENTER);
    const created: { map?: google.maps.Map } = {};

    const loader = new Loader({
      apiKey: GOOGLE_MAPS_API_KEY,
      version: 'weekly',
      libraries: ['places', 'marker', 'routes', 'geocoding'],
    });

    loader.load().then(async () => {
      const { Map, InfoWindow } = (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary;
      const markerLib = (await google.maps.importLibrary('marker')) as google.maps.MarkerLibrary;
      const placesLib = (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary;
      await google.maps.importLibrary('routes');

      const startCenter = await startCenterPromise;

      // The effect may have been cleaned up while the libraries were loading.
      if (cancelled || !mapRef.current) return;

      markerLibRef.current = markerLib;
      placesLibRef.current = placesLib;

      // maxWidth is a hard cap (px) on the card, whatever its content or the map size.
      const infoWindow = new InfoWindow({ maxWidth: 320 });
      // Google has no "is it open?" query, so keep track of it ourselves.
      const originalOpen = infoWindow.open.bind(infoWindow);
      const originalClose = infoWindow.close.bind(infoWindow);
      (infoWindow as any).open = (...args: any[]) => {
        infoOpenRef.current = true;
        return (originalOpen as any)(...args);
      };
      infoWindow.close = () => {
        infoOpenRef.current = false;
        originalClose();
      };
      infoWindow.addListener('closeclick', () => {
        infoOpenRef.current = false;
        cardHiddenByZoomRef.current = false; // the user closed it: don't bring it back by itself
      });
      infoWindowRef.current = infoWindow;
      directionsServiceRef.current = new google.maps.DirectionsService();
      directionsRendererRef.current = new google.maps.DirectionsRenderer({
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: '#1a73e8',
          strokeWeight: 6,
          strokeOpacity: 0.85,
        },
      });

      const map = new google.maps.Map(mapRef.current!, {
        center: startCenter,
        zoom: START_ZOOM,
        mapId: 'DEMO_MAP_ID', 
        mapTypeControl: false, // Ensure default is hidden
        zoomControl: false, // Hide zoom for cleaner look if desired
        // Add other options as needed
      });
      created.map = map;
      
      directionsRendererRef.current.setMap(map);
      placesServiceRef.current = new google.maps.places.PlacesService(map);
      geocoderRef.current = new google.maps.Geocoder();
      setMapInstance(map);

      // Shrink / tuck away / restore the card as the user zooms
      cardBandRef.current = cardBandForZoom(map.getZoom() ?? START_ZOOM);
      map.addListener('zoom_changed', () => {
        const zoom = map.getZoom();
        if (typeof zoom !== 'number') return;
        const band = cardBandForZoom(zoom);
        if (band === cardBandRef.current) return; // only react when a threshold is crossed
        cardBandRef.current = band;

        const iw = infoWindowRef.current;
        if (!iw) return;
        const redraw = () => (currentCardRef.current === 'weather' ? window.showWeatherCard() : window.showPlaceCard());

        if (band === 'hidden') {
          if (infoOpenRef.current) {
            iw.close();
            cardHiddenByZoomRef.current = true;
          }
          return;
        }
        if (cardHiddenByZoomRef.current) {
          // Zoomed back in: bring the card back on the same pin
          cardHiddenByZoomRef.current = false;
          const marker = currentMarkerRef.current;
          if (marker && marker.map && weatherLayerVisibleRef.current && currentPlaceInfoRef.current) {
            redraw();
            iw.open(map, marker);
          }
          return;
        }
        if (infoOpenRef.current) redraw(); // crossed full <-> compact: re-render at the new size
      });

      // Map Click Event Listener
      map.addListener('click', async (mapsMouseEvent: any) => {
        foldPanelOnPhone(); // tapping the map folds the controls away (phones)
        if (!weatherLayerVisibleRef.current) return;
        if (infoWindowRef.current) infoWindowRef.current.close();
        const generation = clearMarkers();

        // Clicked empty map (not a named place): the old pin is already closed above,
        // and we deliberately do not drop a new one.
        if (!mapsMouseEvent.placeId) return;

        // Clicked a named place (shop, park, ...): move the pin there.
        mapsMouseEvent.stop();
        const placeInfo = await getPlaceDetails(mapsMouseEvent.placeId);
        // A newer click/search/route took over while we waited for Google.
        if (generation !== markerGenerationRef.current) return;
        if (placeInfo) {
          createWeatherMarker(mapsMouseEvent.latLng, placeInfo, map, true, generation);
        } else {
          // Place details failed: fall back to a reverse-geocoded pin at the clicked spot.
          handleGeocodeFallback(mapsMouseEvent.latLng, map, generation);
        }
      });
    }).catch((err) => {
      console.error('Failed to initialise Google Maps:', err);
    });

    return () => {
      cancelled = true;
      if (created.map) google.maps.event.clearInstanceListeners(created.map);
      clearMarkers();
      if (infoWindowRef.current) infoWindowRef.current.close();
      if (directionsRendererRef.current) directionsRendererRef.current.setMap(null);
    };
  }, []);

  // Toggle function
  const handleToggleMapType = () => {
    if (!mapInstance) return;

    const nextType = isSatellite ? 'roadmap' : 'satellite';
    mapInstance.setMapTypeId(nextType);
    setIsSatellite(!isSatellite);
  };

  const handleToggleWeather = (e: React.ChangeEvent<HTMLInputElement>) => {
    const isChecked = e.target.checked;
    setShowWeather(isChecked);
    weatherLayerVisibleRef.current = isChecked;

    activeMarkersRef.current.forEach((m) => (m.map = isChecked ? mapInstance : null));
    if (!isChecked && infoWindowRef.current) {
      infoWindowRef.current.close();
    }
  };

  const handleSearchLocation = async () => {
    if (!searchQuery.trim() || !mapInstance) return;
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        searchQuery.trim()
      )}&count=1&language=en&format=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        alert('Location not found!');
        return;
      }

      const result = data.results[0];
      const pos = new google.maps.LatLng(result.latitude, result.longitude);

      mapInstance.panTo(pos);
      mapInstance.setZoom(12);
      foldPanelOnPhone();

      if (infoWindowRef.current) infoWindowRef.current.close();
      clearMarkers();

      if (weatherLayerVisibleRef.current) {
        createWeatherMarker(pos, { name: result.name, address: result.country || '', mapsUri: '', accessibility: null }, mapInstance, true);
      }
    } catch (err) {
      console.error('Search error:', err);
    }
  };

  const calculateAndDisplayRoute = () => {
    if (!routeOrigin.trim() || !routeDestination.trim() || !mapInstance || !directionsServiceRef.current) {
      alert('Please enter both Origin and Destination.');
      return;
    }

    directionsServiceRef.current.route(
      {
        origin:
          originCoordsRef.current && routeOrigin === MY_LOCATION_LABEL ? originCoordsRef.current : routeOrigin,
        destination: routeDestination,
        travelMode: google.maps.TravelMode[routeMode as keyof typeof google.maps.TravelMode],
      },
      async (response, status) => {
        if (status === 'OK' && response && directionsRendererRef.current) {
          directionsRendererRef.current.setDirections(response);
          const leg = response.routes[0].legs[0];

          setRouteSummary({
            modeIcon: routeMode === 'DRIVING' ? '🚗 Driving' : '🚆 Transit',
            duration: leg.duration?.text || '',
            distance: leg.distance?.text || '',
          });
          foldPanelOnPhone();

          if (infoWindowRef.current) infoWindowRef.current.close();
          const generation = clearMarkers();

          // Green Origin Pin
          if (markerLibRef.current && leg.start_location) {
            const originDiv = document.createElement('div');
            originDiv.className = 'origin-marker';
            originDiv.innerText = '🟢 Start';
            const originMarker = new markerLibRef.current.AdvancedMarkerElement({
              map: mapInstance,
              position: leg.start_location,
              content: originDiv,
            });
            activeMarkersRef.current.push(originMarker);
          }

          // Destination Pin
          // Only add the weather pin when "Show Weather Pins" is ticked. Map click and
          // search already behave this way; the route used to ignore the checkbox.
          if (leg.end_location && weatherLayerVisibleRef.current) {
            let destPlaceId: string | null = null;
            if (response.geocoded_waypoints && response.geocoded_waypoints.length > 1) {
              destPlaceId = response.geocoded_waypoints[response.geocoded_waypoints.length - 1].place_id || null;
            }

            const fallbackInfo: PlaceInfo = {
              name: routeDestination,
              address: leg.end_address || '',
              mapsUri: '',
              accessibility: null,
            };

            let destInfo: PlaceInfo | null = null;
            if (destPlaceId) {
              destInfo = await getPlaceDetails(destPlaceId);
              // A newer click/search/route may have taken over while we waited for Google.
              if (generation !== markerGenerationRef.current) return;
            }

            createWeatherMarker(leg.end_location, destInfo || fallbackInfo, mapInstance, true, generation);
          }
        } else {
          setRouteSummary(null);
          alert('Could not calculate directions: ' + status);
        }
      }
    );
  };

  const clearRoute = () => {
    if (directionsRendererRef.current) {
      directionsRendererRef.current.setDirections({ routes: [] } as any);
    }
    setRouteSummary(null);
    setRouteOrigin('');
    originCoordsRef.current = null;
    setRouteDestination('');
    if (infoWindowRef.current) infoWindowRef.current.close();
    clearMarkers();
  };

  // ---- Locate me ---------------------------------------------------------
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  const showToast = (message: string) => {
    setToastMessage(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 5000);
  };

  // Street address for a position, or '' if Google cannot find one.
  const reverseGeocodeAddress = (pos: LatLngLike): Promise<string> =>
    new Promise((resolve) => {
      if (!geocoderRef.current) return resolve('');
      geocoderRef.current.geocode({ location: pos }, (results, status) => {
        resolve(status === 'OK' && results && results[0] ? results[0].formatted_address : '');
      });
    });

  // Map button: centre on the user and show the weather where they are.
  const handleLocateMe = async () => {
    if (!mapInstance || locating) return;
    setLocating(true);
    setToastMessage(null);
    try {
      const pos = await requestPosition();
      mapInstance.panTo(pos);
      mapInstance.setZoom(15);
      foldPanelOnPhone();
      if (infoWindowRef.current) infoWindowRef.current.close();
      const generation = clearMarkers();

      if (weatherLayerVisibleRef.current) {
        const address = await reverseGeocodeAddress(pos);
        // A newer click/search/route took over while Google was answering.
        if (generation !== markerGenerationRef.current) return;
        createWeatherMarker(
          pos,
          {
            name: MY_LOCATION_LABEL,
            address,
            mapsUri: `https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}`,
            accessibility: null,
          },
          mapInstance,
          true,
          generation
        );
      }
    } catch (err) {
      showToast(geolocationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  // Origin field button: fill the origin with the user's current position.
  const handleUseMyLocationAsOrigin = async () => {
    if (originLocating) return;
    setOriginLocating(true);
    try {
      const pos = await requestPosition();
      originCoordsRef.current = pos;
      setRouteOrigin(MY_LOCATION_LABEL);
    } catch (err) {
      showToast(geolocationErrorMessage(err));
    } finally {
      setOriginLocating(false);
    }
  };

  return (
    <div>
      <div id="map-controls" className={panelOpen ? 'panel-open' : 'panel-collapsed'}>
        {/* Mobile only: tap to expand/collapse the controls (hidden on desktop by CSS) */}
        <button
          type="button"
          className="panel-toggle"
          onClick={() => setPanelOpen((open) => !open)}
          aria-expanded={panelOpen}
          aria-controls="map-controls-body"
        >
          <svg className="panel-toggle-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            <circle cx="15" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="9" cy="17" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="panel-toggle-label">
            {routeSummary
              ? `${routeSummary.modeIcon} · ${routeSummary.duration} · ${routeSummary.distance}`
              : 'Map controls'}
          </span>
          <span className="panel-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
        </button>

        <div id="map-controls-body" className="panel-body">
          <div className="panel-body-inner">
            {/* Unique Map Type Toggle Header */}
            <div className="control-section map-toggle-header">
              <div className="custom-map-toggle-wrapper">
                <button
                  type="button"
                  onClick={handleToggleMapType}
                  className={`pill-toggle ${isSatellite ? 'active-satellite' : 'active-standard'}`}
                  aria-label="Toggle Map View"
                >
                  <div className="toggle-option standard">
                    <span>🗺️ Standard</span>
                  </div>
                  <div className="toggle-option satellite">
                    <span>🛰️ Satellite</span>
                  </div>
                  <div className="pill-slider" />
                </button>
              </div>
            </div>

            {/* Section 1: Explore Location */}
            <div className="control-section">
              <h3>Explore Location</h3>
              <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={showWeather} onChange={handleToggleWeather} />
                <span>Show Weather Pins</span>
              </label>

              <div className="input-group">
                <input
                  type="text"
                  placeholder="Search city or place..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchLocation()}
                />
                <button className="btn-primary" onClick={handleSearchLocation}>
                  Search Location
                </button>
              </div>
            </div>

            {/* Section 2: Get Directions */}
            <div className="control-section">
              <h3>Get Directions</h3>
              <div className="input-group">
                <div className="input-with-action">
                  <input
                    type="text"
                    placeholder="Origin (e.g. Auckland Central)"
                    aria-label="Route origin"
                    value={routeOrigin}
                    onChange={(e) => {
                      setRouteOrigin(e.target.value);
                      originCoordsRef.current = null; // typed text replaces any saved "My location"
                    }}
                  />
                  <button
                    type="button"
                    className={`origin-locate-btn${originLocating ? ' locating' : ''}`}
                    onClick={handleUseMyLocationAsOrigin}
                    disabled={originLocating}
                    aria-label="Use my location as the origin"
                    title="Use my location"
                  >
                    <LocateIcon size={18} />
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="Destination (e.g. Westfield Albany)"
                  value={routeDestination}
                  onChange={(e) => setRouteDestination(e.target.value)}
                />

                <select value={routeMode} onChange={(e) => setRouteMode(e.target.value)}>
                  <option value="DRIVING">🚗 Driving (Car)</option>
                  <option value="TRANSIT">🚆 Public Transport</option>
                </select>
              </div>

              <div className="btn-row">
                <button className="btn-primary" onClick={calculateAndDisplayRoute}>
                  Get Route
                </button>
                <button className="btn-secondary" onClick={clearRoute}>
                  Clear
                </button>
              </div>

              {routeSummary && (
                <div id="route-info">
                  <b>{routeSummary.modeIcon} Route Found:</b>
                  <br />
                  ⏱️ <b>Time:</b> {routeSummary.duration}
                  <br />
                  📏 <b>Distance:</b> {routeSummary.distance}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div id="map" ref={mapRef} />

      {/* Round button under the Google fullscreen control: centre the map on me */}
      <button
        type="button"
        className={`locate-btn${locating ? ' locating' : ''}`}
        onClick={handleLocateMe}
        disabled={!mapInstance || locating}
        aria-label="Show my location"
        title="Show my location"
      >
        <LocateIcon />
      </button>

      {toastMessage && (
        <div className="map-toast" role="alert">
          {toastMessage}
        </div>
      )}
    </div>
  );
};

export default App;