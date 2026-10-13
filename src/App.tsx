import React, { useEffect, useRef, useState } from 'react';
import { Loader } from '@googlemaps/js-api-loader';
import './styles.css';

import type { LatLngLike, PlaceInfo, RouteSummary } from './types';
import { DEFAULT_CENTER, GOOGLE_MAPS_API_KEY, MY_LOCATION_LABEL, START_ZOOM, isPhone } from './constants';
import { withTimeout } from './utils';
import { geolocationErrorMessage, getStartingCenter, requestPosition } from './services/location';
import { fetchDetailedWeather, getWeatherIcon, searchCity } from './services/weather';
import type { WeatherResponse } from './services/weather';
import { getPlaceDetails, placeInfoFromGeocode } from './services/places';
import { directionsErrorMessage } from './services/directions';
import { cardBandForZoom, renderPlaceCardHTML, renderWeatherCardHTML } from './cards';
import type { CardBand } from './cards';
import { ControlsPanel } from './components/ControlsPanel';
import { MapTypeToggle } from './components/MapTypeToggle';
import { SearchSection } from './components/SearchSection';
import { DirectionsSection } from './components/DirectionsSection';
import { LocateIcon } from './components/LocateIcon';

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
  const currentWeatherDataRef = useRef<WeatherResponse | null>(null);
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

  // Mount Window Functions for Inline Onclick Events
  useEffect(() => {
    window.showPlaceCard = () => {
      if (currentPlaceInfoRef.current && infoWindowRef.current) {
        currentCardRef.current = 'place';
        infoWindowRef.current.setContent(renderPlaceCardHTML(currentPlaceInfoRef.current, cardBandRef.current));
      }
    };

    window.showWeatherCard = () => {
      if (currentPlaceInfoRef.current && currentWeatherDataRef.current && infoWindowRef.current) {
        currentCardRef.current = 'weather';
        infoWindowRef.current.setContent(
          renderWeatherCardHTML(currentPlaceInfoRef.current, currentWeatherDataRef.current, cardBandRef.current)
        );
      }
    };
  }, []);

  const lookUpPlace = (placeId: string) =>
    getPlaceDetails(placesLibRef.current, placesServiceRef.current, placeId);

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
      createWeatherMarker(latLng, placeInfoFromGeocode(latLng, results, status), targetMap, true, generation);
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
        const placeInfo = await lookUpPlace(mapsMouseEvent.placeId);
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
      const result = await searchCity(searchQuery.trim());

      if (!result) {
        showToast(`Couldn't find "${searchQuery.trim()}". Try a city or town name.`);
        return;
      }

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
      showToast('Search failed. Check your connection and try again.');
    }
  };

  const calculateAndDisplayRoute = () => {
    if (!mapInstance || !directionsServiceRef.current) return; // map not loaded yet
    if (!routeOrigin.trim() || !routeDestination.trim()) {
      showToast('Please enter both an origin and a destination.');
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
              destInfo = await lookUpPlace(destPlaceId);
              // A newer click/search/route may have taken over while we waited for Google.
              if (generation !== markerGenerationRef.current) return;
            }

            createWeatherMarker(leg.end_location, destInfo || fallbackInfo, mapInstance, true, generation);
          }
        } else {
          setRouteSummary(null);
          console.warn('Directions failed:', status);
          showToast(directionsErrorMessage(status));
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
      <ControlsPanel
        open={panelOpen}
        onToggle={() => setPanelOpen((open) => !open)}
        label={
          routeSummary
            ? `${routeSummary.modeIcon} · ${routeSummary.duration} · ${routeSummary.distance}`
            : 'Map controls'
        }
      >
        <MapTypeToggle isSatellite={isSatellite} onToggle={handleToggleMapType} />
        <SearchSection
          showWeather={showWeather}
          onToggleWeather={handleToggleWeather}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSearch={handleSearchLocation}
        />
        <DirectionsSection
          origin={routeOrigin}
          onOriginChange={(value) => {
            setRouteOrigin(value);
            originCoordsRef.current = null; // typed text replaces any saved "My location"
          }}
          onUseMyLocation={handleUseMyLocationAsOrigin}
          originLocating={originLocating}
          destination={routeDestination}
          onDestinationChange={setRouteDestination}
          mode={routeMode}
          onModeChange={setRouteMode}
          onGetRoute={calculateAndDisplayRoute}
          onClear={clearRoute}
          summary={routeSummary}
        />
      </ControlsPanel>
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
