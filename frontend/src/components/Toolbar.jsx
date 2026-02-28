import React, { useState } from 'react';

const Icons = {
  Plus: () => <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />,
  Minus: () => <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />,
  Search: () => <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />,
  Layers: () => <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />,
};

function Toolbar({ mapInstance, onLocationSelect, basemap, setBasemap, className }) {
  const [activeTool, setActiveTool] = useState(null);
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const handleZoomIn = () => mapInstance?.zoomIn();
  const handleZoomOut = () => mapInstance?.zoomOut();
  const toggleTool = (tool) => setActiveTool(activeTool === tool ? null : tool);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query) return;
    setIsSearching(true);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (data && data.length > 0) {
        const result = data[0];
        const bbox = [parseFloat(result.boundingbox[2]), parseFloat(result.boundingbox[0]), parseFloat(result.boundingbox[3]), parseFloat(result.boundingbox[1])];
        onLocationSelect(bbox, result.display_name);
        setActiveTool(null);
        setQuery('');
      } else {
        alert('Location not found');
      }
    } catch (error) { console.error(error); }
    setIsSearching(false);
  };

  const btnClass = "w-9 h-9 bg-white border border-gray-200 text-gray-600 hover:text-cyan-600 hover:bg-gray-50 flex items-center justify-center transition-colors shadow-sm relative z-20";

  return (
    <div className={`flex flex-col font-sans shadow-lg rounded-md ${className}`}>
      <div className="relative group">
        <button onClick={() => toggleTool('search')} className={`${btnClass} rounded-t-md ${activeTool === 'search' ? 'text-cyan-600 bg-cyan-50' : ''}`} title="Search Location">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><Icons.Search /></svg>
        </button>
        {activeTool === 'search' && (
          <div className="absolute left-10 top-0 bg-white p-2 rounded shadow-xl border border-gray-200 w-64 flex gap-1 h-9 items-center z-50">
            <form onSubmit={handleSearch} className="flex gap-1 w-full">
              <input autoFocus type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="City, Country..."
                className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 outline-none focus:border-cyan-500" />
              <button type="submit" disabled={isSearching} className="bg-cyan-500 text-white px-2 py-1 rounded text-xs font-bold hover:bg-cyan-600">
                {isSearching ? '..' : 'Go'}
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="relative">
        <button onClick={() => toggleTool('layers')} className={`${btnClass} border-t-0 ${activeTool === 'layers' ? 'text-cyan-600 bg-cyan-50' : ''}`} title="Change Basemap">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><Icons.Layers /></svg>
        </button>
        {activeTool === 'layers' && (
          <div className="absolute left-10 top-0 bg-white rounded shadow-xl border border-gray-200 overflow-hidden w-48 z-50">
            <div className="text-[10px] uppercase font-bold text-gray-400 px-3 py-2 bg-gray-50 border-b border-gray-100">Basemap</div>
            {[{ id: 'carto', label: 'Carto Light' }, { id: 'hot', label: 'Humanitarian OSM' }, { id: 'satellite', label: 'Mapbox Satellite' }].map(opt => (
              <button key={opt.id} onClick={() => { setBasemap(opt.id); setActiveTool(null); }}
                className={`block w-full text-left px-4 py-2 text-xs font-medium hover:bg-gray-50 ${basemap === opt.id ? 'text-cyan-600 bg-cyan-50' : 'text-gray-700'}`}>
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button onClick={handleZoomIn} className={`${btnClass} border-t-0`} title="Zoom In">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><Icons.Plus /></svg>
      </button>
      <button onClick={handleZoomOut} className={`${btnClass} border-t-0 rounded-b-md`} title="Zoom Out">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><Icons.Minus /></svg>
      </button>
    </div>
  );
}

export default Toolbar;
