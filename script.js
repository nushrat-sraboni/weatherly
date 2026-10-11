"use strict";

/* ==========================================================
   Weatherly: script.js
   Uses the free Open-Meteo APIs (no API key needed).
   ========================================================== */

// ---------- 1. Settings ----------
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_CITY = "Dhaka"; // loaded automatically when the page opens

// ---------- 2. WMO weather codes -> description + emoji icon ----------
// Open-Meteo returns a number called "weather_code". This table turns it into words and an icon.
// "nightIcon" is used when it is dark outside (is_day = 0). If missing, the normal icon is used.
const WEATHER_CODES = {
  0:  { description: "Clear sky",                    icon: "☀️", nightIcon: "🌙" },
  1:  { description: "Mainly clear",                 icon: "🌤️", nightIcon: "🌙" },
  2:  { description: "Partly cloudy",                icon: "⛅", nightIcon: "☁️" },
  3:  { description: "Overcast",                     icon: "☁️" },
  45: { description: "Fog",                          icon: "🌫️" },
  48: { description: "Depositing rime fog",          icon: "🌫️" },
  51: { description: "Light drizzle",                icon: "🌦️" },
  53: { description: "Moderate drizzle",             icon: "🌦️" },
  55: { description: "Dense drizzle",                icon: "🌧️" },
  56: { description: "Light freezing drizzle",       icon: "🌧️" },
  57: { description: "Dense freezing drizzle",       icon: "🌧️" },
  61: { description: "Slight rain",                  icon: "🌦️" },
  63: { description: "Moderate rain",                icon: "🌧️" },
  65: { description: "Heavy rain",                   icon: "🌧️" },
  66: { description: "Light freezing rain",          icon: "🌧️" },
  67: { description: "Heavy freezing rain",          icon: "🌧️" },
  71: { description: "Slight snow",                  icon: "🌨️" },
  73: { description: "Moderate snow",                icon: "🌨️" },
  75: { description: "Heavy snow",                   icon: "❄️" },
  77: { description: "Snow grains",                  icon: "❄️" },
  80: { description: "Slight rain showers",          icon: "🌦️" },
  81: { description: "Moderate rain showers",        icon: "🌧️" },
  82: { description: "Violent rain showers",         icon: "⛈️" },
  85: { description: "Slight snow showers",          icon: "🌨️" },
  86: { description: "Heavy snow showers",           icon: "🌨️" },
  95: { description: "Thunderstorm",                 icon: "⛈️" },
  96: { description: "Thunderstorm with slight hail", icon: "⛈️" },
  99: { description: "Thunderstorm with heavy hail",  icon: "⛈️" }
};

// ---------- 3. Grab the page elements we need ----------
const searchForm = document.getElementById("search-form");
const cityInput = document.getElementById("city-input");
const unitCButton = document.getElementById("unit-c");
const unitFButton = document.getElementById("unit-f");
const statusRegion = document.getElementById("status");

// The four "panels". Only one is visible at a time.
const panels = {
  welcome: document.getElementById("welcome-state"),
  loading: document.getElementById("loading-state"),
  error: document.getElementById("error-state"),
  weather: document.getElementById("weather-state")
};

const errorMessage = document.getElementById("error-message");
const cityNameEl = document.getElementById("city-name");
const localTimeEl = document.getElementById("local-time");
const weatherIconEl = document.getElementById("weather-icon");
const temperatureEl = document.getElementById("temperature");
const descriptionEl = document.getElementById("description");
const feelsLikeEl = document.getElementById("feels-like");
const humidityEl = document.getElementById("humidity");
const windEl = document.getElementById("wind");

// ---------- 4. App state (values that change while the app runs) ----------
let currentUnit = "C";         // "C" or "F"
let latestLocation = null;     // the last city we successfully loaded
let latestWeather = null;      // the last weather data we successfully loaded
let latestRequestId = 0;       // goes up by 1 for every new search
let activeController = null;   // lets us cancel a search that is still running

// A small custom error type. Its message is always safe and friendly to show to the user.
class ApiError extends Error {}

// ---------- 5. Small helper functions ----------

// True only for real, finite numbers (rejects null, undefined, NaN, strings...)
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Show one panel and hide the others
function showPanel(name) {
  for (const key in panels) {
    panels[key].hidden = key !== name;
  }
}

// Show an error message (textContent keeps it safe from injected HTML)
function showError(message) {
  errorMessage.textContent = message;
  showPanel("error");
}

// Update the hidden live region so screen readers hear what happened
function announce(message) {
  statusRegion.textContent = message;
}

// Celsius -> Fahrenheit
function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32;
}

// Format a Celsius number in whichever unit is selected, e.g. "28°C" or "82°F"
function formatTemperature(celsius) {
  if (!isNumber(celsius)) {
    return "N/A";
  }
  const value = currentUnit === "F" ? celsiusToFahrenheit(celsius) : celsius;
  return `${Math.round(value)}°${currentUnit}`;
}

// Turn a time like "2026-10-12T14:15" into "Mon, 12 Oct · 14:15 local time"
function formatLocalTime(isoString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoString);
  if (!match) {
    return "";
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const dateText = date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
  return `${dateText} · ${match[4]}:${match[5]} local time`;
}

// Look up a weather code. Unknown codes get a safe fallback instead of breaking.
function getWeatherInfo(code, isDay) {
  const info = WEATHER_CODES[code];
  if (!info) {
    return { description: "Conditions unavailable", icon: "🌡️" };
  }
  return {
    description: info.description,
    icon: !isDay && info.nightIcon ? info.nightIcon : info.icon
  };
}

// ---------- 6. Talking to the APIs ----------

// Fetch a URL and return its JSON. Turns every kind of failure into a friendly ApiError.
async function fetchJson(url, signal) {
  let response;

  try {
    response = await fetch(url, { signal });
  } catch (error) {
    // If we cancelled on purpose, pass that along untouched
    if (error.name === "AbortError") {
      throw error;
    }
    // Otherwise the network itself failed (offline, blocked, DNS problem...)
    throw new ApiError(
      "We couldn't reach the weather service. Check your internet connection and try again."
    );
  }

  // The server answered, but with an error code (400, 500, ...)
  if (!response.ok) {
    throw new ApiError(
      `The weather service had a problem (error ${response.status}). Please try again in a moment.`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError("The weather service sent back something we couldn't read. Please try again.");
  }

  // Open-Meteo reports some problems as { "error": true, "reason": "..." }
  if (data && data.error === true) {
    throw new ApiError("The weather service couldn't complete that request. Please try again.");
  }

  return data;
}

// Step 1: city name -> latitude and longitude
async function findCity(cityName, signal) {
  const params = new URLSearchParams({
    name: cityName,
    count: "1",
    language: "en",
    format: "json"
  });

  const data = await fetchJson(`${GEOCODING_URL}?${params}`, signal);

  // When nothing matches, Open-Meteo leaves out "results" completely
  if (!data || !Array.isArray(data.results) || data.results.length === 0) {
    throw new ApiError(
      `We couldn't find a city called "${cityName}". Check the spelling or try another city.`
    );
  }

  const place = data.results[0];

  if (!place || !isNumber(place.latitude) || !isNumber(place.longitude)) {
    throw new ApiError("We found that city, but its location data was incomplete. Please try another search.");
  }

  // Build a display name like "Dhaka, Dhaka Division, Bangladesh"
  const nameParts = [place.name, place.admin1, place.country].filter(
    (part, index, all) => typeof part === "string" && part !== "" && all.indexOf(part) === index
  );

  return {
    displayName: nameParts.join(", ") || cityName,
    latitude: place.latitude,
    longitude: place.longitude
  };
}

// Step 2: latitude + longitude -> current weather
async function getCurrentWeather(latitude, longitude, signal) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
    timezone: "auto"
  });

  const data = await fetchJson(`${FORECAST_URL}?${params}`, signal);
  const current = data && data.current;

  // Without a real temperature we have nothing useful to show, so treat it as a failure.
  if (!current || typeof current !== "object" || !isNumber(current.temperature_2m)) {
    throw new ApiError("The weather service didn't return complete weather data. Please try again.");
  }

  // Everything else is optional: if it's missing, we show "N/A" instead of inventing a value.
  return {
    temperatureC: current.temperature_2m,
    feelsLikeC: isNumber(current.apparent_temperature) ? current.apparent_temperature : null,
    humidity: isNumber(current.relative_humidity_2m) ? current.relative_humidity_2m : null,
    windKmh: isNumber(current.wind_speed_10m) ? current.wind_speed_10m : null,
    weatherCode: isNumber(current.weather_code) ? current.weather_code : null,
    isDay: current.is_day !== 0, // is_day is 1 (day) or 0 (night)
    time: typeof current.time === "string" ? current.time : ""
  };
}

// ---------- 7. Drawing the results ----------

// Fills the weather card. Runs after a search AND when you switch °C/°F.
function renderWeather() {
  if (!latestLocation || !latestWeather) {
    return;
  }

  const info = getWeatherInfo(latestWeather.weatherCode, latestWeather.isDay);

  // textContent (not innerHTML) so API text can never inject HTML
  cityNameEl.textContent = latestLocation.displayName;
  localTimeEl.textContent = formatLocalTime(latestWeather.time);
  weatherIconEl.textContent = info.icon;
  weatherIconEl.setAttribute("aria-label", info.description);
  temperatureEl.textContent = formatTemperature(latestWeather.temperatureC);
  descriptionEl.textContent = info.description;
  feelsLikeEl.textContent = formatTemperature(latestWeather.feelsLikeC);
  humidityEl.textContent = isNumber(latestWeather.humidity) ? `${Math.round(latestWeather.humidity)}%` : "N/A";
  windEl.textContent = isNumber(latestWeather.windKmh) ? `${Math.round(latestWeather.windKmh)} km/h` : "N/A";
}

// ---------- 8. The main search flow ----------

// Cancels any search still in progress and makes its result "stale".
function cancelActiveRequest() {
  latestRequestId += 1; // any older request now has an out-of-date ID
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

async function loadWeather(rawCity, isInitialLoad = false) {
  const city = rawCity.trim();

  // Stop any older search first so it can't overwrite what we show next
  cancelActiveRequest();

  // Empty input check
  if (city === "") {
    showError("Please type a city name to search.");
    announce("Please type a city name to search.");
    return;
  }

  // Give THIS search its own ID and its own cancel switch
  const requestId = latestRequestId;
  const controller = new AbortController();
  activeController = controller;

  showPanel("loading");
  announce(`Loading weather for ${city}…`);

  try {
    const location = await findCity(city, controller.signal);
    if (requestId !== latestRequestId) return; // a newer search started: ignore this one

    const weather = await getCurrentWeather(location.latitude, location.longitude, controller.signal);
    if (requestId !== latestRequestId) return; // check again after the second request

    latestLocation = location;
    latestWeather = weather;
    renderWeather();
    showPanel("weather");
    announce(`Showing current weather for ${location.displayName}.`);
  } catch (error) {
    // Ignore errors from searches that were cancelled or replaced
    if (requestId !== latestRequestId || error.name === "AbortError") return;

    if (error instanceof ApiError) {
      showError(error.message);
    } else {
      console.error("Unexpected error:", error); // visible in the browser console for debugging
      showError("Something unexpected went wrong. Please try again.");
    }

    // If even the automatic Dhaka load failed, keep the welcome message visible too
    if (isInitialLoad) {
      panels.welcome.hidden = false;
    }
  } finally {
    // Clean up, but only if this search is still the current one
    if (requestId === latestRequestId) {
      activeController = null;
    }
  }
}

// ---------- 9. Celsius / Fahrenheit toggle ----------
function setUnit(unit) {
  currentUnit = unit;

  unitCButton.classList.toggle("is-active", unit === "C");
  unitFButton.classList.toggle("is-active", unit === "F");
  unitCButton.setAttribute("aria-pressed", String(unit === "C"));
  unitFButton.setAttribute("aria-pressed", String(unit === "F"));

  renderWeather(); // redraw numbers with the new unit (no new network request needed)
}

// ---------- 10. Event listeners ----------

// A form handles both the Search button click AND pressing Enter in the input
searchForm.addEventListener("submit", (event) => {
  event.preventDefault(); // stop the page from reloading
  loadWeather(cityInput.value);
});

unitCButton.addEventListener("click", () => setUnit("C"));
unitFButton.addEventListener("click", () => setUnit("F"));

// ---------- 11. Start the app ----------
// Load Dhaka as soon as the page opens
loadWeather(DEFAULT_CITY, true);