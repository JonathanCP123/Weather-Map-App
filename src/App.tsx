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

  // Helpers
  const getWeatherIcon = (code: number, rain: number, isDay = 1): string => {
    if (rain > 0) return '🌧️';
    if (code >= 95) return '⚡';
    if (isDay === 1) {
      if (code === 0) return '☀️';
      if (code <= 3) return '⛅';
      return '☁️';
    } else {
      if (code === 0) return '🌙';
      return '☁️';
    }
  };

  const formatHourString = (isoStr: string): string => {
    if (!isoStr || !isoStr.includes('T')) return '';
    const hour = parseInt(isoStr.split('T')[1].split(':')[0], 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12} ${ampm}`;
  };

  const clearMarkers = () => {
    activeMarkersRef.current.forEach((m) => (m.map = null));
    activeMarkersRef.current = [];
  };

  const fetchDetailedWeather = async (lat: number, lng: number) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,weather_code,precipitation,is_day&timezone=auto`;
    const response = await fetch(url);
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
      <div class="place-card-popup">
          <div class="place-card-header">
              <h3 class="place-card-title">${placeInfo.name}</h3>
              <a href="${mapsLink}" target="_blank" class="place-card-link-btn" title="Open in Google Maps">↗</a>
          </div>
          ${placeInfo.address ? `<div class="place-card-address">${placeInfo.address}</div>` : ''}
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
    const currentIsoTime = current.time;
    let startIdx = hourly && hourly.time ? hourly.time.findIndex((t: string) => t >= currentIsoTime) : 0;
    if (startIdx === -1) startIdx = 0;

    for (let i = startIdx; i < startIdx + 5 && i < hourly.time.length; i++) {
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
      <div class="unified-popup">
          <div class="place-header">
              <div class="back-to-place-btn" onclick="window.showPlaceCard()">← Back to Place Info</div>
              <h3>📍 Destination: ${placeInfo.name}</h3>
              ${placeInfo.address ? `<p>${placeInfo.address}</p>` : ''}
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
        infoWindowRef.current.setContent(renderPlaceCardHTML(currentPlaceInfoRef.current));
      }
    };

    window.showWeatherCard = () => {
      if (currentPlaceInfoRef.current && currentWeatherDataRef.current && infoWindowRef.current) {
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
  const handleGeocodeFallback = (latLng: google.maps.LatLng, targetMap: google.maps.Map) => {
    if (!geocoderRef.current) return;
    geocoderRef.current.geocode({ location: latLng }, (results, status) => {
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

      createWeatherMarker(latLng, placeInfo, targetMap, true);
    });
  };

  // Create Weather Marker Pin
  const createWeatherMarker = async (
    position: google.maps.LatLng | google.maps.LatLngLiteral,
    placeInfo: PlaceInfo,
    targetMap: google.maps.Map,
    autoOpen = true
  ) => {
    if (!markerLibRef.current || !infoWindowRef.current) return;

    const markerDiv = document.createElement('div');
    markerDiv.className = 'weather-marker';
    markerDiv.innerText = '⏳ Loading...';

    const marker = new markerLibRef.current.AdvancedMarkerElement({
      map: targetMap,
      position: position,
      content: markerDiv,
    });

    activeMarkersRef.current.push(marker);

    const lat = typeof position.lat === 'function' ? position.lat() : position.lat;
    const lng = typeof position.lng === 'function' ? position.lng() : position.lng;

    try {
      const weatherData = await fetchDetailedWeather(lat, lng);
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
        window.showWeatherCard();
        if (infoWindowRef.current) infoWindowRef.current.open(targetMap, marker);
      });

      if (autoOpen) {
        window.showPlaceCard();
        infoWindowRef.current.open(targetMap, marker);
      }
    } catch (err) {
      console.error('Weather error:', err);
      markerDiv.innerText = '⚠️ N/A';
    }
  };

  // Initialize Map
  useEffect(() => {
    const loader = new Loader({
      apiKey: GOOGLE_MAPS_API_KEY,
      version: 'weekly',
      libraries: ['places', 'marker', 'routes', 'geocoding'],
    });

    loader.load().then(async () => {
      const { Map, InfoWindow } = (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary;
      markerLibRef.current = (await google.maps.importLibrary('marker')) as google.maps.MarkerLibrary;
      placesLibRef.current = (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary;
      await google.maps.importLibrary('routes');

      infoWindowRef.current = new InfoWindow();
      directionsServiceRef.current = new google.maps.DirectionsService();
      directionsRendererRef.current = new google.maps.DirectionsRenderer({
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: '#1a73e8',
          strokeWeight: 6,
          strokeOpacity: 0.85,
        },
      });

      if (!mapRef.current) return;

      const map = new Map(mapRef.current, {
        center: { lat: -36.8485, lng: 174.7633 },
        zoom: 12,
        mapId: 'DEMO_MAP_ID',
      });

      directionsRendererRef.current.setMap(map);
      placesServiceRef.current = new google.maps.places.PlacesService(map);
      geocoderRef.current = new google.maps.Geocoder();
      setMapInstance(map);

      // Map Click Event Listener
      map.addListener('click', async (mapsMouseEvent: any) => {
        if (!weatherLayerVisibleRef.current) return;
        if (infoWindowRef.current) infoWindowRef.current.close();
        clearMarkers();

        if (mapsMouseEvent.placeId) {
          mapsMouseEvent.stop();
          const placeInfo = await getPlaceDetails(mapsMouseEvent.placeId);
          if (placeInfo) {
            createWeatherMarker(mapsMouseEvent.latLng, placeInfo, map, true);
          } else {
            handleGeocodeFallback(mapsMouseEvent.latLng, map);
          }
        } else {
          handleGeocodeFallback(mapsMouseEvent.latLng, map);
        }
      });
    });
  }, []);

  // Control Functions
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
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        alert('Location not found!');
        return;
      }

      const result = data.results[0];
      const pos = new google.maps.LatLng(result.latitude, result.longitude);

      mapInstance.panTo(pos);
      mapInstance.setZoom(12);

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
        origin: routeOrigin,
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

          if (infoWindowRef.current) infoWindowRef.current.close();
          clearMarkers();

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
          let destPlaceId: string | null = null;
          if (response.geocoded_waypoints && response.geocoded_waypoints.length > 1) {
            destPlaceId = response.geocoded_waypoints[response.geocoded_waypoints.length - 1].place_id || null;
          }

          if (leg.end_location) {
            if (destPlaceId) {
              const placeInfo = await getPlaceDetails(destPlaceId);
              if (placeInfo) {
                createWeatherMarker(leg.end_location, placeInfo, mapInstance, true);
              } else {
                createWeatherMarker(
                  leg.end_location,
                  { name: routeDestination, address: leg.end_address || '', mapsUri: '', accessibility: null },
                  mapInstance,
                  true
                );
              }
            } else {
              createWeatherMarker(
                leg.end_location,
                { name: routeDestination, address: leg.end_address || '', mapsUri: '', accessibility: null },
                mapInstance,
                true
              );
            }
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
    setRouteDestination('');
    if (infoWindowRef.current) infoWindowRef.current.close();
    clearMarkers();
  };

  return (
    <div>
      <div id="map-controls">
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

        <div className="control-section">
          <h3>Get Directions</h3>
          <div className="input-group">
            <input
              type="text"
              placeholder="Origin (e.g. Auckland Central)"
              value={routeOrigin}
              onChange={(e) => setRouteOrigin(e.target.value)}
            />
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

      <div id="map" ref={mapRef} />
    </div>
  );
};

export default App;