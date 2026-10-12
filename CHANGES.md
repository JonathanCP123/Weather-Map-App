# App.tsx bug-fix pass: what I changed and why

This documents everything done in the first fix pass on `src/App.tsx`: what I did, in what order, and the reason for each decision. Scope was the seven bugs from the code review (items 1-7 under "Bugs and correctness"). Nothing from the accessibility, mobile/CSS, API-migration, or restructuring sections was touched on purpose; those are listed at the end so it's clear what was left alone.

**Deliverable:** a drop-in replacement for `src/App.tsx`. No other file changes, no new dependencies, no new files.

---

## 1. How I worked

1. **Read everything first.** I read the whole of `App.tsx` (the first view was truncated in the middle, so I read lines 212-423 separately), plus `main.tsx`, `styles.css`, `package.json`, and `tsconfig.json`, so the fixes fit your actual setup (`strict: false`, React 18, Vite).
2. **Kept the original untouched** and edited a working copy, so I could diff the two at the end.
3. **Noticed your file uses Windows (CRLF) line endings.** I edited with LF so the tooling behaved, then converted back to CRLF at the end. Your editor and git will not see a file where every line has changed.
4. **Applied edits with a script, not by hand.** Every edit either replaces a specific line range (after asserting the first line is what I expected) or replaces a snippet that must match exactly once, otherwise the script stops. This is a guard against silent mistakes in a 630-line file.
5. **Verified** (see section 5), then read the complete diff line by line to make sure only the intended hunks changed.

---

## 2. Summary

| # | Problem | Fix | Where |
|---|---|---|---|
| 1 | The "Now" forecast card showed the *next* hour | Match the current hour instead of "first time >= now" | `findCurrentHourIndex`, `renderWeatherCardHTML` |
| 2 | Weather icons wrong for fog, drizzle, snow, thunder-with-rain; overcast shown as partly cloudy | Full WMO weather-code to icon mapping | `getWeatherIcon` |
| 3 | In dev, StrictMode could create two maps and duplicate click listeners; no cleanup on unmount | `cancelled` flag, cleanup function, `.catch` | map-init `useEffect` |
| 4 | Fast clicks/searches could show stale results or open cards on removed pins | "Generation" counter plus `AbortController` | `clearMarkers`, `createWeatherMarker`, click handler, geocode fallback, route |
| 5 | The route ignored the "Show Weather Pins" checkbox | Route respects the checkbox; no card opens on a hidden pin | `calculateAndDisplayRoute`, `createWeatherMarker` |
| 6 | Place names/addresses were inserted into HTML unescaped | `escapeHtml()` on all text; `rel="noopener noreferrer"` on the external link | card renderers |
| 7 | Small issues | `res.ok` check on search, removed unused state, helpers moved out of the component | various |

---

## 3. Each change in detail

### Fix 1: "Now" card showed the next hour

**Problem.** The hourly strip started at the first hourly entry where `time >= current.time`. Hourly entries are on the hour (`14:00`, `15:00`). If `current.time` is `14:15`, `14:00 >= 14:15` is false, so the strip starts at `15:00` but labels it "Now".

**Why it matters.** The first card is meant to be the current hour. With the old logic it is always off by one hour whenever `current.time` isn't exactly on the hour. When `current.time` *is* exactly on the hour, the old code happened to work, which is why it's an easy bug to miss.

**Change.**

```ts
// before
let startIdx = hourly && hourly.time ? hourly.time.findIndex((t) => t >= currentIsoTime) : 0;
if (startIdx === -1) startIdx = 0;

// after
const startIdx = hourly && hourly.time ? findCurrentHourIndex(hourly.time, current.time) : 0;
```

`findCurrentHourIndex` compares only the first 13 characters (`YYYY-MM-DDTHH`) of both strings, so `14:15` matches the `14:00` entry. Both values are in the same local time zone because the request uses `timezone=auto`, so the string comparison is valid.

I also replaced `i < hourly.time.length` in the loop with a precomputed `hourlyCount` that is 0 when `hourly` is missing. The old guard on the line above allowed `hourly` to be undefined, but the loop would then crash on `hourly.time.length`.

**Honest caveat.** I could not call the live API from my sandbox (no network), and the documentation I found only shows that Open-Meteo's `current` block carries its own interval, not that `current.time` is `:15`-aligned for Auckland. So I can't say how often you were hitting this bug. The fix is correct either way. To check: open DevTools, Network tab, click a place, and look at `current.time` in the Open-Meteo response.

---

### Fix 2: Weather icons

**Problem.** The old function did this, in order: any `precipitation > 0` gives rain; code >= 95 gives thunder; then only codes 0 and <= 3 were handled; everything else was a cloud. Consequences:

- Snow (71-77, 85-86) showed as rain (if precipitation > 0) or cloud.
- Fog (45, 48), drizzle (51-57) and showers (80-82) showed as cloud unless precipitation happened to be > 0.
- Thunderstorm with rain showed as rain, because the rain check ran first.
- Code 3 is *overcast* but was shown as partly cloudy.

**Change.** A mapping covering the WMO codes Open-Meteo documents, with day/night variants for clear and partly cloudy:

| Code(s) | Meaning | Icon |
|---|---|---|
| 0 | Clear | ☀️ day / 🌙 night |
| 1 | Mainly clear | 🌤️ day / 🌙 night |
| 2 | Partly cloudy | ⛅ day / ☁️ night |
| 3 | Overcast | ☁️ |
| 45, 48 | Fog | 🌫️ |
| 51-57 | Drizzle (incl. freezing) | 🌦️ |
| 61-67 | Rain (incl. freezing) | 🌧️ |
| 71-77, 85, 86 | Snow | ❄️ |
| 80-82 | Rain showers | 🌧️ |
| 95-99 | Thunderstorm (incl. hail) | ⛈️ |

For an unrecognised code, it falls back to the old idea: `precipitation > 0` gives 🌧️, otherwise ☁️. The function signature `(code, rain, isDay)` is unchanged, so no call site changed.

**Decision to flag.** Thunder used to be ⚡ and is now ⛈️, which matches the other weather emoji better. It's a one-character change in `getWeatherIcon` if you prefer ⚡.

---

### Fix 3: StrictMode double-run and missing cleanup in the map-init effect

**Problem.** In development, `React.StrictMode` (which you use in `main.tsx`) deliberately runs every effect twice: mount, cleanup, mount. Your effect had no cleanup and no guard. Both runs waited on the Google loader, and both then built a map on the same `<div>` and attached a click listener. The visible symptom is two markers per click in dev. Separately, there was no cleanup if the component unmounted, and no error handling if the loader failed (for example, a bad key).

**Change.**

- `let cancelled = false;` at the top of the effect, set to `true` in the cleanup. After the `await`s, `if (cancelled || !mapRef.current) return;` stops the abandoned run before it creates anything.
- The shared refs (`markerLibRef`, `placesLibRef`) are now assigned *after* that check, so an abandoned run can't write to them.
- The cleanup removes the map's listeners (`clearInstanceListeners`), clears pins, closes the InfoWindow, and detaches the directions renderer.
- `.catch(...)` logs a clear message if Google Maps fails to load, instead of an unhandled promise rejection.
- The `if (!mapRef.current) return;` that used to sit in the middle was folded into the new guard at the top.

**Why `created.map` and not `let map`.** The cleanup needs a reference to the map that is created later, inside the async callback. I used a small object (`const created = {}`) instead of `let map: Map | null = null`, because with `strict: true` TypeScript narrows a `let` that is assigned inside a callback to `never` in the cleanup code. Your config has `strict: false`, so it would work either way, but I recommended turning `strict` on, and this avoids a surprise later.

**Production note.** StrictMode's double-run is dev-only, so production users never saw the duplicate map. The cleanup is still correct and useful on unmount.

---

### Fix 4: Stale requests (race conditions)

**Problem.** Several things are asynchronous: the Google place lookup, the reverse geocode, and the Open-Meteo fetch. All results were applied when they arrived, regardless of what the user had done since. If you click place A and quickly click place B, A's results can still arrive after `clearMarkers()` has removed A's pin, and then:

- A's weather overwrites the shared `currentPlaceInfoRef` / `currentWeatherDataRef`, so B's card can show A's data, and
- A's card can open on a pin that is no longer on the map.

The same applies to search and route calculations interleaving with clicks.

**Change: a "generation" counter plus abort.**

```ts
const markerGenerationRef = useRef<number>(0);
const weatherAbortRef = useRef<AbortController | null>(null);

const clearMarkers = (): number => {
  markerGenerationRef.current += 1;      // invalidate everything started before now
  weatherAbortRef.current?.abort();      // cancel the in-flight weather request
  ...remove pins...
  return markerGenerationRef.current;    // the new generation
};
```

Every flow follows the same pattern: call `clearMarkers()` and remember the number it returns; after any `await` or callback, compare it to the current number and quietly stop if it has moved on.

| Flow | Where the guard is |
|---|---|
| Map click | after `await getPlaceDetails(...)` |
| Reverse-geocode fallback | at the start of the geocode callback |
| Route | after `await getPlaceDetails(destPlaceId)` |
| Weather fetch | right after `await fetchDetailedWeather(...)`, and in the `catch` |
| Search | no guard needed: there is no `await` between `clearMarkers()` and `createWeatherMarker()` |

`createWeatherMarker` and `handleGeocodeFallback` gained an optional trailing `generation` parameter that defaults to the current value, so any call site that doesn't pass it still behaves as before.

`fetchDetailedWeather` now accepts an `AbortSignal` and passes it to `fetch`, so superseded weather requests are actually cancelled on the network (you'll see them as "(canceled)" in DevTools). An abort throws an `AbortError`, which the `catch` now treats as expected and ignores instead of logging an error or showing "⚠️ N/A".

**Why a counter instead of only aborting.** Aborting only covers the weather `fetch`. The Google place lookup and geocoder callbacks can't be aborted the same way, so the counter is what makes those safe. Using both gives the right behaviour with one simple rule: "if the generation moved on, drop the result."

---

### Fix 5: Route ignored the "Show Weather Pins" checkbox

**Problem.** Map click and search both check `weatherLayerVisibleRef` and do nothing when pins are off. The route code always created the destination weather pin, so unticking the box and then requesting a route still popped up a weather card.

**Change.**

- The destination pin block is now wrapped in `if (leg.end_location && weatherLayerVisibleRef.current)`.
- In `createWeatherMarker`, `autoOpen` now also requires `weatherLayerVisibleRef.current`. This covers the case where you untick the box while a weather request is still loading; before, the card would open on a pin that was already hidden.

**Trade-off to be aware of.** With the box unticked, the route line and the "Start" pin are still drawn, but no destination pin is created. If you then tick the box again, there is no destination pin until the next route. I chose this because it matches how click and search already behave, and it also skips the Google place lookup and weather call that would otherwise be wasted. The alternative (create the pin hidden, so it appears when the box is ticked) costs API calls for something the user can't see. Easy to switch if you prefer it.

**Refactor that came with it.** The destination block had the same `createWeatherMarker(...)` call written out in three branches. Adding the generation argument to all three would have tripled the risk of missing one, so I merged them: look up place details if there is a place ID, otherwise use the fallback info, then make one call. The behaviour is identical.

---

### Fix 6: HTML injection in the cards

**Problem.** The cards are built as HTML strings and passed to `InfoWindow.setContent`. `placeInfo.name` and `placeInfo.address` were inserted raw. Those values come from Google (trusted) but also from the destination text field (`name: routeDestination` in the fallback) and from Open-Meteo's geocoder, so something like `<img onerror=...>` in a field would be interpreted as HTML. The practical risk is low, since it's mostly "self-XSS", but it also breaks display for any name containing `&` or `<`.

**Change.** A small `escapeHtml()` helper (escapes `& < > " '`) applied to the name and address in both cards, and to the Maps URL placed in the `href`. I also added `rel="noopener noreferrer"` to the `target="_blank"` link so the opened page can't reach back into your app via `window.opener`.

**Why escaping rather than building DOM elements.** Building real DOM nodes is the better long-term design (and would let us remove the `window.showPlaceCard` globals), but it's a larger rewrite. Escaping closes the hole with a tiny change now and fits the "bug fixes first" scope. The DOM approach is on the later list.

---

### Fix 7: Smaller items

- **Search checks `res.ok`.** A failed Open-Meteo geocoding response now throws and is handled by the existing `try/catch`, instead of failing when it tries to parse an error body.
- **Removed unused state.** `activeMapType` was declared but never used anywhere.
- **Helpers moved to module scope.** `getWeatherIcon` and `formatHourString` don't use state, so they no longer get re-created on every render. The new `escapeHtml` and `findCurrentHourIndex` live next to them. They are pure functions, which also made them easy to test on their own (section 5).
- **Loader failure is logged** (part of Fix 3).

---

## 4. Behaviour changes you may notice

1. "Now" in the forecast strip now shows the current hour.
2. Snow, fog, drizzle, showers, and thunderstorms get appropriate icons; thunder is ⛈️ (was ⚡).
3. With "Show Weather Pins" unticked, a route draws the line and Start pin but no destination weather pin.
4. Rapid clicking no longer leaves stale pins or cards, and cancelled weather requests appear as "(canceled)" in DevTools.
5. In dev, you should no longer get two markers per click.

Everything else (layout, CSS, API calls, other behaviour) is unchanged.

---

## 5. Verification

**What I ran:**

| Check | Result |
|---|---|
| Syntax check of the patched file with the TypeScript compiler | 0 diagnostics |
| Full type-check of original and patched files using your tsconfig flags (`strict: false`, ES2020, bundler resolution) | 0 errors in both. Because the sandbox is offline, the React/Google Maps typings were replaced by loose stand-ins, so this checks my logic (signatures, refs, parameters) but not the real vendor types. |
| 25 unit checks on the new helpers, extracted verbatim from `App.tsx` | All pass |
| Line-by-line read of the complete diff | Only intended hunks changed |
| Line endings | Original and output are consistently CRLF (633 and 723 lines, no mixed endings) |

The unit checks cover: the "Now" index at 14:00 / 14:15 / 14:45, an unmatched time, and missing data; a check that the old logic did pick the next hour; every icon category including the cases the old code got wrong; escaping of tags, quotes, `&`, null and undefined; and the hour labels.

**What I could not run:** the app itself in a browser, against the real Google Maps and Open-Meteo APIs. The sandbox has no network and no `node_modules`. So the concurrency fixes (3, 4, 5) are verified by reading and type-checking, not by watching them run. Please run through this checklist:

1. `npm run build` completes with no errors (this uses your real types).
2. `npm run dev`: click a place once and confirm **one** pin appears (Fix 3).
3. Click five different places quickly. Only the last should keep a pin and card, and DevTools Network should show the earlier weather requests as canceled (Fix 4).
4. Throttle the network to "Slow 3G", click a place, then immediately search a city. The search result should win and no stale card should appear (Fix 4).
5. Untick "Show Weather Pins" and request a route. The line should draw with no destination pin or card (Fix 5).
6. Click a place and untick the box before the weather loads. No card should pop open (Fix 5).
7. Open a card and compare "Now" with the hour of day, and look at `current.time` in the Network response (Fix 1).
8. Click a place whose name contains `&` (for example "Marks & Spencer"); it should display as `&`, not `&amp;` (Fix 6).

---

## 6. Noticed but deliberately not changed

So you can see the scope boundary, these are things I saw while working and left alone:

- **Toggling "Show Weather Pins" off also hides the green "Start" pin**, because `handleToggleWeather` hides every marker in `activeMarkersRef`. That is probably unintended, but it's a design decision, so I left it.
- **Marker click vs auto-open show different cards.** A new pin opens the place card first; clicking the pin later opens the weather card directly. Possibly intended.
- **`alert()` for errors**, the accessibility items (div-as-button, labels, focus rings), iOS 12px input zoom, `100vh`, legacy `DirectionsService` / `PlacesService`, the search using Open-Meteo's geocoder, request caching, and the `window.*` globals with inline `onclick`. All are in the earlier review and belong in the next passes.
- **`DEMO_MAP_ID`**, the Maps API key rotation and restriction (please still do this), and the README.

---

## 7. How to apply

1. Replace `src/App.tsx` with the provided file. It keeps your CRLF line endings, so `git diff` shows only the real changes.
2. Run `npm run build`, then work through the checklist above.
3. If something misbehaves, the change log above maps each behaviour to the exact function to look at, and the original is just your previous `App.tsx` from git.
