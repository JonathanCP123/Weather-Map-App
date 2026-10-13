import React from 'react';
import type { RouteSummary } from '../types';
import { LocateIcon } from './LocateIcon';

interface DirectionsSectionProps {
  origin: string;
  onOriginChange: (value: string) => void;
  onUseMyLocation: () => void;
  originLocating: boolean;
  destination: string;
  onDestinationChange: (value: string) => void;
  mode: string;
  onModeChange: (value: string) => void;
  onGetRoute: () => void;
  onClear: () => void;
  summary: RouteSummary | null;
}

/** "Get Directions": origin/destination inputs, travel mode, and the route result. */
export const DirectionsSection: React.FC<DirectionsSectionProps> = ({
  origin,
  onOriginChange,
  onUseMyLocation,
  originLocating,
  destination,
  onDestinationChange,
  mode,
  onModeChange,
  onGetRoute,
  onClear,
  summary,
}) => (
  <div className="control-section">
    <h3>Get Directions</h3>
    <div className="input-group">
      <div className="input-with-action">
        <input
          type="text"
          placeholder="Origin (e.g. Auckland Central)"
          aria-label="Route origin"
          value={origin}
          onChange={(e) => onOriginChange(e.target.value)}
        />
        <button
          type="button"
          className={`origin-locate-btn${originLocating ? ' locating' : ''}`}
          onClick={onUseMyLocation}
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
        value={destination}
        onChange={(e) => onDestinationChange(e.target.value)}
      />

      <select value={mode} onChange={(e) => onModeChange(e.target.value)}>
        <option value="DRIVING">🚗 Driving (Car)</option>
        <option value="TRANSIT">🚆 Public Transport</option>
      </select>
    </div>

    <div className="btn-row">
      <button className="btn-primary" onClick={onGetRoute}>
        Get Route
      </button>
      <button className="btn-secondary" onClick={onClear}>
        Clear
      </button>
    </div>

    {summary && (
      <div id="route-info">
        <b>{summary.modeIcon} Route Found:</b>
        <br />
        ⏱️ <b>Time:</b> {summary.duration}
        <br />
        📏 <b>Distance:</b> {summary.distance}
      </div>
    )}
  </div>
);
