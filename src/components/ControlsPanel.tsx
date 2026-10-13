import React from 'react';

interface ControlsPanelProps {
  open: boolean;
  onToggle: () => void;
  /** Text on the toggle bar (e.g. the trip summary when the panel is collapsed). */
  label: string;
  children: React.ReactNode;
}

/** The floating controls panel. On phones it collapses into a bar with a toggle button. */
export const ControlsPanel: React.FC<ControlsPanelProps> = ({ open, onToggle, label, children }) => (
  <div id="map-controls" className={open ? 'panel-open' : 'panel-collapsed'}>
    {/* Mobile only: tap to expand/collapse the controls (hidden on desktop by CSS) */}
    <button
      type="button"
      className="panel-toggle"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="map-controls-body"
    >
      <svg className="panel-toggle-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        <circle cx="15" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="9" cy="17" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="panel-toggle-label">{label}</span>
      <span className="panel-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
    </button>

    <div id="map-controls-body" className="panel-body">
      <div className="panel-body-inner">{children}</div>
    </div>
  </div>
);
