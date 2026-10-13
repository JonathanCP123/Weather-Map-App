import React from 'react';

interface SearchSectionProps {
  showWeather: boolean;
  onToggleWeather: (e: React.ChangeEvent<HTMLInputElement>) => void;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}

/** "Explore Location": the weather-pins checkbox and the city search. */
export const SearchSection: React.FC<SearchSectionProps> = ({
  showWeather,
  onToggleWeather,
  query,
  onQueryChange,
  onSearch,
}) => (
  <div className="control-section">
    <h3>Explore Location</h3>
    <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
      <input type="checkbox" checked={showWeather} onChange={onToggleWeather} />
      <span>Show Weather Pins</span>
    </label>

    <div className="input-group">
      <input
        type="text"
        placeholder="Search city or place..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSearch()}
      />
      <button className="btn-primary" onClick={onSearch}>
        Search Location
      </button>
    </div>
  </div>
);
