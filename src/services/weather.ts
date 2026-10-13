// Open-Meteo requests: the weather forecast and the city search.

/** The parts of Open-Meteo's forecast response that the app reads. */
export interface WeatherResponse {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
    is_day: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    weather_code: number[];
    precipitation: number[];
    is_day: number[];
  };
}

export interface CitySearchResult {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
}

export const fetchDetailedWeather = async (
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<WeatherResponse> => {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,weather_code,precipitation,is_day&timezone=auto`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Weather fetch failed');
  return await response.json();
};

/** Best match for a city name, or null if Open-Meteo finds nothing. */
export const searchCity = async (query: string): Promise<CitySearchResult | null> => {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    query
  )}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();
  return data.results && data.results.length > 0 ? data.results[0] : null;
};

/** Maps an Open-Meteo WMO weather code to an emoji. */
export const getWeatherIcon = (code: number, rain: number, isDay = 1): string => {
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

export const formatHourString = (isoStr: string): string => {
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
export const findCurrentHourIndex = (hourlyTimes: string[], currentTime: string): number => {
  if (!hourlyTimes || !currentTime) return 0;
  const currentHour = currentTime.slice(0, 13);
  const idx = hourlyTimes.findIndex((t) => t.slice(0, 13) === currentHour);
  return idx === -1 ? 0 : idx;
};
