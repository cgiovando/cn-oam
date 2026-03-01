import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Map from './components/Map';
import MapFilterBar from './components/MapFilterBar';
import Toolbar from './components/Toolbar';
import MiniMap from './components/MiniMap';
import BurgerMenu from './components/BurgerMenu';
import UploadModal from './components/UploadModal';
import { initCatalog, searchCatalog, getCatalogStats } from './lib/catalog';

function App() {
  const [features, setFeatures] = useState([]);
  const [selectedFeature, setSelectedFeature] = useState(null);
  const [mapBbox, setMapBbox] = useState(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogStats, setCatalogStats] = useState(null);
  const [isSearching, setIsSearching] = useState(false);

  // Map state
  const [mapInstance, setMapInstance] = useState(null);
  const [mapCenter, setMapCenter] = useState([0, 20]);
  const [mapBounds, setMapBounds] = useState(null);
  const [viewportBbox, setViewportBbox] = useState(null);

  const initialUrlSelectionDone = useRef(false);

  // UI state
  const [previewsEnabled, setPreviewsEnabled] = useState(true);
  const [hoveredFeatureId, setHoveredFeatureId] = useState(null);
  const [basemap, setBasemap] = useState('carto');
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  const [filters, setFilters] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      dateStart: params.get('dateStart') || '',
      dateEnd: params.get('dateEnd') || '',
      platform: params.get('platform') || '',
      license: params.get('license') || ''
    };
  });

  // Initialize DuckDB catalog on mount
  useEffect(() => {
    initCatalog()
      .then(() => {
        setCatalogReady(true);
        return getCatalogStats();
      })
      .then(stats => setCatalogStats(stats))
      .catch(err => console.warn('[app] Catalog init error:', err.message));
  }, []);

  // Search catalog when viewport or filters change
  const searchDebounce = useRef(null);
  const runSearch = useCallback(async (bbox, currentFilters) => {
    if (!catalogReady || !bbox) return;
    setIsSearching(true);
    try {
      const results = await searchCatalog({
        bbox,
        dateStart: currentFilters.dateStart,
        dateEnd: currentFilters.dateEnd,
        platform: currentFilters.platform,
        license: currentFilters.license,
      });
      setFeatures(results);
    } catch (err) {
      console.warn('[app] Search error:', err.message);
    }
    setIsSearching(false);
  }, [catalogReady]);

  // Trigger search when viewport changes
  useEffect(() => {
    if (!viewportBbox) return;
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      runSearch(viewportBbox, filters);
    }, 300);
    return () => clearTimeout(searchDebounce.current);
  }, [viewportBbox, filters, runSearch]);

  // Restore selection from URL
  useEffect(() => {
    if (features.length > 0 && !initialUrlSelectionDone.current) {
      const params = new URLSearchParams(window.location.search);
      const urlSelectedId = params.get('selected_id');
      if (urlSelectedId) {
        const feature = features.find(f => f.properties.id === urlSelectedId);
        if (feature) setSelectedFeature(feature);
      }
      initialUrlSelectionDone.current = true;
    }
  }, [features]);

  const updateUrlSelection = (feature) => {
    const params = new URLSearchParams(window.location.search);
    if (feature) params.set('selected_id', feature.properties.id);
    else params.delete('selected_id');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  };

  const handleSelectFeature = (feature) => {
    setSelectedFeature(feature);
    updateUrlSelection(feature);
  };

  const handleFilterChange = (newFilters) => {
    setFilters(newFilters);
    const params = new URLSearchParams(window.location.search);
    ['dateStart', 'dateEnd', 'platform', 'license'].forEach(key => {
      if (newFilters[key]) params.set(key, newFilters[key]);
      else params.delete(key);
    });
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  };

  const handleLocationSelect = (bbox) => {
    setMapBbox(bbox);
  };

  const handleMapMoveEnd = (bbox, center, exactBounds) => {
    setMapCenter(center);
    setMapBounds(exactBounds);
    setViewportBbox(exactBounds);
  };

  return (
    <div className="flex w-full h-screen overflow-hidden bg-gray-100 font-sans">

      {/* SIDEBAR */}
      <div className="flex flex-col w-96 h-full bg-white border-r border-gray-200 shadow-xl z-20 relative">
        <Sidebar
          features={features}
          onSelect={handleSelectFeature}
          selectedFeature={selectedFeature}
          catalogStats={catalogStats}
          isSearching={isSearching}
          onUploadClick={() => setUploadModalOpen(true)}
        />
      </div>

      {/* MAP AREA */}
      <div className="flex-1 h-full relative">

        {/* Filters */}
        <div className="absolute top-4 left-4 z-30 w-full max-w-2xl">
          <MapFilterBar filters={filters} onChange={handleFilterChange} />
        </div>

        {/* Burger Menu */}
        <BurgerMenu />

        {/* MiniMap */}
        <div className="absolute bottom-12 right-4 z-30">
          <MiniMap center={mapCenter} bounds={mapBounds} />
        </div>

        {/* Toolbar */}
        <Toolbar
          className="absolute bottom-36 left-4 z-30"
          mapInstance={mapInstance}
          onLocationSelect={handleLocationSelect}
          basemap={basemap}
          setBasemap={setBasemap}
        />

        {/* Map */}
        <Map
          onMapInit={setMapInstance}
          selectedFeature={selectedFeature}
          onSelect={handleSelectFeature}
          features={features}
          searchBbox={mapBbox}
          onSearchArea={handleMapMoveEnd}
          previewsEnabled={previewsEnabled}
          setPreviewsEnabled={setPreviewsEnabled}
          hoveredFeatureId={hoveredFeatureId}
          onHover={setHoveredFeatureId}
          basemap={basemap}
          filters={filters}
        />
      </div>

      {/* Upload Modal */}
      <UploadModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          if (viewportBbox) runSearch(viewportBbox, filters);
        }}
      />
    </div>
  );
}

export default App;
