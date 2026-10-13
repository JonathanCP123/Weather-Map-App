import React from 'react';

interface MapTypeToggleProps {
  isSatellite: boolean;
  onToggle: () => void;
}

/** Pill switch between the standard and satellite map. */
export const MapTypeToggle: React.FC<MapTypeToggleProps> = ({ isSatellite, onToggle }) => (
  <div className="control-section map-toggle-header">
    <div className="custom-map-toggle-wrapper">
      <button
        type="button"
        onClick={onToggle}
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
);
