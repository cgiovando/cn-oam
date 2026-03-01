import React, { useState, useEffect, useRef } from 'react';
import ImageCard from './ImageCard';

const ITEMS_PER_PAGE = 10;

function Sidebar({ features, onSelect, selectedFeature, catalogStats, isSearching, onUploadClick }) {
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
  const listRef = useRef(null);
  const prevFeatureIdsRef = useRef('');

  useEffect(() => {
    const ids = features.map(f => f.properties.id).join(',');
    if (ids !== prevFeatureIdsRef.current) {
      prevFeatureIdsRef.current = ids;
      setVisibleCount(ITEMS_PER_PAGE);
      if (!selectedFeature && listRef.current) listRef.current.scrollTop = 0;
    }
  }, [features, selectedFeature]);

  useEffect(() => {
    if (selectedFeature) {
      const index = features.findIndex(f => f.properties.id === selectedFeature.properties.id);
      if (index >= visibleCount) setVisibleCount(index + 5);
    }
  }, [selectedFeature, features, visibleCount]);

  const handleLoadMore = () => {
    setVisibleCount(prev => Math.min(prev + ITEMS_PER_PAGE, features.length));
  };

  const getHeaderText = () => {
    if (isSearching) return 'Searching...';
    if (features.length === 0) return 'No images in view';
    return `${features.length} image${features.length !== 1 ? 's' : ''} in view`;
  };

  const visibleFeatures = features.slice(0, visibleCount);

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto bg-gray-50 relative scroll-smooth font-sans">
      <div className="p-5 border-b border-gray-200 bg-white sticky top-0 z-20 shadow-sm">
        {/* Logo + Upload */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <img src={`${import.meta.env.BASE_URL}oam-logo.svg`} alt="OpenAerialMap" className="h-6" />
            <span className="text-[9px] px-1.5 py-0.5 bg-cyan-100 text-cyan-700 rounded-full font-bold uppercase">cn</span>
          </div>
          <button
            onClick={onUploadClick}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-xs font-bold rounded-lg hover:from-cyan-600 hover:to-blue-700 transition-all shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Upload
          </button>
        </div>

        {/* Stats + Search Status */}
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isSearching ? 'bg-amber-400 animate-pulse' : 'bg-cyan-500'}`}></span>
          {getHeaderText()}
        </p>

        {catalogStats && (
          <p className="text-[10px] text-gray-400 mt-1">
            {catalogStats.totalImages.toLocaleString()} total images in catalog
          </p>
        )}
      </div>

      <div className="p-4 space-y-4">
        {features.length > 0 ? (
          <>
            {visibleFeatures.map((feature) => (
              <ImageCard
                key={feature.properties.id}
                feature={feature}
                onSelect={onSelect}
                isSelected={selectedFeature && selectedFeature.properties.id === feature.properties.id}
              />
            ))}
            {visibleCount < features.length && (
              <button
                onClick={handleLoadMore}
                className="w-full py-3 bg-white border border-gray-300 text-gray-600 font-semibold rounded hover:bg-gray-50 hover:text-cyan-600 transition-colors shadow-sm"
              >
                Load More ({features.length - visibleCount} remaining)
              </button>
            )}
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-gray-500">
              {isSearching ? 'Searching catalog...' : 'Pan the map to search for imagery.'}
            </p>
            <p className="text-xs text-gray-400 mt-2">
              Powered by DuckDB-WASM + GeoParquet
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
