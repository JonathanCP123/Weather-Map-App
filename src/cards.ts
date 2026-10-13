// HTML for the cards shown in the Google Maps InfoWindow, and their zoom-based sizing.

import type { PlaceInfo } from './types';
import type { WeatherResponse } from './services/weather';
import { findCurrentHourIndex, formatHourString, getWeatherIcon } from './services/weather';
import { escapeHtml } from './utils';

export const CARD_FULL_MIN_ZOOM = 12;
export const CARD_HIDE_BELOW_ZOOM = 10;
export type CardBand = 'full' | 'compact' | 'hidden';
export const cardBandForZoom = (zoom: number): CardBand =>
  zoom >= CARD_FULL_MIN_ZOOM ? 'full' : zoom >= CARD_HIDE_BELOW_ZOOM ? 'compact' : 'hidden';

export const renderPlaceCardHTML = (placeInfo: PlaceInfo, band: CardBand): string => {
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
    <div class="place-card-popup ${band === 'full' ? '' : 'card-compact'}">
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

export const renderWeatherCardHTML = (
  placeInfo: PlaceInfo,
  weatherData: WeatherResponse,
  band: CardBand
): string => {
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
    <div class="unified-popup ${band === 'full' ? '' : 'card-compact'}">
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
