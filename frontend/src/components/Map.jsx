import React, { useRef, useEffect, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import bbox from '@turf/bbox';
import 'maplibre-gl/dist/maplibre-gl.css';

const MB_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';

// PMTiles footprint source (optional — catalog search works without it)
const PMTILES_URL = import.meta.env.VITE_PMTILES_URL || null;

function OamMap({ selectedFeature, onMapInit, searchBbox, onSearchArea, onSelect, features, previewsEnabled, setPreviewsEnabled, hoveredFeatureId, onHover, basemap, filters }) {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const popupRef = useRef(null);
  const debounceTimer = useRef(null);
  const isProgrammaticMove = useRef(false);
  const onSearchRef = useRef(onSearchArea);
  const onSelectRef = useRef(onSelect);
  const selectedFeatureRef = useRef(selectedFeature);
  const onHoverRef = useRef(onHover);
  const featuresRef = useRef(features);

  const [isLoaded, setIsLoaded] = useState(false);
  const [mapZoom, setMapZoom] = useState(2);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { selectedFeatureRef.current = selectedFeature; }, [selectedFeature]);
  useEffect(() => { onSearchRef.current = onSearchArea; }, [onSearchArea]);
  useEffect(() => { onHoverRef.current = onHover; }, [onHover]);
  useEffect(() => { featuresRef.current = features; }, [features]);

  const getInitialViewState = () => {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));
    const zoom = parseFloat(params.get('zoom'));
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(zoom)) return { center: [lon, lat], zoom };
    return { center: [0, 20], zoom: 2 };
  };

  const updateUrlView = () => {
    if (!map.current) return;
    const center = map.current.getCenter();
    const zoom = map.current.getZoom();
    const params = new URLSearchParams(window.location.search);
    params.set('lat', center.lat.toFixed(4));
    params.set('lon', center.lng.toFixed(4));
    params.set('zoom', zoom.toFixed(1));
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  };

  const closePopup = () => {
    if (popupRef.current) {
      popupRef.current.remove();
      popupRef.current = null;
    }
  };

  // Build GeoJSON FeatureCollection from DuckDB search results
  const buildFeatureCollection = (feats) => ({
    type: 'FeatureCollection',
    features: feats || []
  });

  // Build centroid points from polygon features for low-zoom markers
  const buildCentroidCollection = (feats) => ({
    type: 'FeatureCollection',
    features: (feats || []).map(f => {
      const coords = f.geometry?.coordinates?.[0];
      if (!coords || coords.length < 4) return null;
      // Centroid of bbox rectangle
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      const cx = (Math.min(...lons) + Math.max(...lons)) / 2;
      const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [cx, cy] },
        properties: f.properties
      };
    }).filter(Boolean)
  });

  // 1. INITIALIZE MAP
  useEffect(() => {
    if (map.current) return;

    // Register protocols
    const pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
    maplibregl.addProtocol('cog', cogProtocol);

    const { center, zoom } = getInitialViewState();

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'basemap-source': {
            type: 'raster',
            tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap &copy; CARTO'
          }
        },
        layers: [
          { id: 'basemap-layer', type: 'raster', source: 'basemap-source' }
        ]
      },
      center,
      zoom,
      attributionControl: false
    });

    if (onMapInit) onMapInit(map.current);
    map.current.addControl(new maplibregl.AttributionControl(), 'bottom-right');

    map.current.on('load', () => {
      setIsLoaded(true);
      updateUrlView();

      // GeoJSON source for DuckDB search results (footprints)
      map.current.addSource('search-results', {
        type: 'geojson',
        data: buildFeatureCollection([]),
        promoteId: 'id'
      });

      // Centroid points for low-zoom markers
      map.current.addSource('search-centroids', {
        type: 'geojson',
        data: buildCentroidCollection([]),
        promoteId: 'id'
      });

      // Optional: PMTiles vector source for pre-built footprint tiles
      if (PMTILES_URL) {
        map.current.addSource('oam-tiles', {
          type: 'vector',
          url: `pmtiles://${PMTILES_URL}`,
          promoteId: '_id'
        });
      }

      // --- Footprint polygon layers (visible at higher zoom) ---
      map.current.addLayer({
        id: 'footprint-fill',
        type: 'fill',
        source: 'search-results',
        minzoom: 8,
        paint: {
          'fill-color': '#00E5FF',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 0.15]
        }
      });
      map.current.addLayer({
        id: 'footprint-line',
        type: 'line',
        source: 'search-results',
        minzoom: 8,
        paint: {
          'line-color': '#00B0FF',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 0.8]
        }
      });

      // --- Centroid circle markers (visible at all zoom, fade at high zoom) ---
      map.current.addLayer({
        id: 'centroid-circles',
        type: 'circle',
        source: 'search-centroids',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 6, 6, 10, 8, 14, 10],
          'circle-color': '#00B0FF',
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 13, 0.2],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 1, 10, 2],
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 0.1]
        }
      });

      // Hover highlight for centroids
      map.current.addLayer({
        id: 'centroid-hover',
        type: 'circle',
        source: 'search-centroids',
        filter: ['==', ['get', 'id'], ''],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 10, 12],
          'circle-color': '#2196F3',
          'circle-opacity': 0.9,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2
        }
      });

      // Hover highlight for footprints
      map.current.addLayer({
        id: 'footprint-hover',
        type: 'line',
        source: 'search-results',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#2196F3', 'line-width': 3, 'line-opacity': 0.9 }
      });

      // Selection highlight
      map.current.addLayer({
        id: 'footprint-highlight',
        type: 'line',
        source: 'search-results',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#FF0000', 'line-width': 3 }
      });

      // --- EVENTS ---

      const interactiveLayers = ['footprint-fill', 'centroid-circles'];

      map.current.on('mousemove', (e) => {
        const hits = map.current.queryRenderedFeatures(e.point, { layers: interactiveLayers });
        const hoveredId = hits.length > 0 ? hits[0].properties.id : null;
        if (onHoverRef.current) onHoverRef.current(hoveredId);
        map.current.getCanvas().style.cursor = hoveredId ? 'pointer' : '';
      });

      map.current.on('click', (e) => {
        closePopup();

        const hits = map.current.queryRenderedFeatures(e.point, { layers: interactiveLayers });
        if (hits.length > 0) {
          // De-duplicate
          const uniqueMap = new Map();
          for (const h of hits) {
            const id = h.properties.id;
            if (id && !uniqueMap.has(id)) {
              // Find full feature from our features array
              const fullFeature = featuresRef.current.find(f => f.properties.id === id) || h;
              uniqueMap.set(id, fullFeature);
            }
          }
          const uniqueFeatures = [...uniqueMap.values()];

          if (uniqueFeatures.length === 1) {
            if (onSelectRef.current) onSelectRef.current(uniqueFeatures[0]);
            return;
          }

          // Multiple features — disambiguation popup
          if (uniqueFeatures.length > 1) {
            const container = document.createElement('div');
            container.className = 'oam-popup-container';
            const header = document.createElement('div');
            header.className = 'oam-popup-header';
            header.textContent = `${uniqueFeatures.length} images here`;
            container.appendChild(header);
            const items = document.createElement('div');
            items.className = 'oam-popup-items';
            for (const feat of uniqueFeatures) {
              const fp = feat.properties;
              const item = document.createElement('div');
              item.className = 'oam-popup-item';
              const title = document.createElement('div');
              title.className = 'oam-popup-item-title';
              title.textContent = fp.title || 'Untitled';
              item.appendChild(title);
              const meta = document.createElement('div');
              meta.className = 'oam-popup-item-meta';
              const dateStr = fp.datetime
                ? new Date(fp.datetime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : 'Unknown Date';
              meta.textContent = `${dateStr} · ${fp.provider || fp.producer_name || 'Unknown'}`;
              item.appendChild(meta);
              item.addEventListener('click', () => {
                if (onSelectRef.current) onSelectRef.current(feat);
                closePopup();
              });
              items.appendChild(item);
            }
            container.appendChild(items);
            popupRef.current = new maplibregl.Popup({
              closeButton: true, closeOnClick: true, maxWidth: '280px', className: 'oam-disambig-popup'
            }).setLngLat(e.lngLat).setDOMContent(container).addTo(map.current);
            return;
          }
        }

        // Click outside — deselect
        if (onSelectRef.current) onSelectRef.current(null);
      });

      map.current.on('movestart', () => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
      });

      map.current.on('moveend', () => {
        updateUrlView();
        setMapZoom(map.current.getZoom());
        if (isProgrammaticMove.current) { isProgrammaticMove.current = false; return; }
        debounceTimer.current = setTimeout(() => {
          if (!map.current) return;
          const bounds = map.current.getBounds();
          const center = map.current.getCenter();
          const bboxArray = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
          if (onSearchRef.current) onSearchRef.current(bboxArray, [center.lng, center.lat], bboxArray);
        }, 300);
      });

      // Fire initial search area
      const bounds = map.current.getBounds();
      const center = map.current.getCenter();
      const bboxArray = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      if (onSearchRef.current) onSearchRef.current(bboxArray, [center.lng, center.lat], bboxArray);
    });
  }, []);

  // 2. Update search results on map when features change
  useEffect(() => {
    if (!map.current || !isLoaded) return;
    const source = map.current.getSource('search-results');
    if (source) {
      source.setData(buildFeatureCollection(features));
    }
    const centroidSource = map.current.getSource('search-centroids');
    if (centroidSource) {
      centroidSource.setData(buildCentroidCollection(features));
    }
  }, [features, isLoaded]);

  // 3. SEARCH
  useEffect(() => {
    if (!map.current || !isLoaded || !searchBbox) return;
    try { isProgrammaticMove.current = true; map.current.fitBounds(searchBbox, { padding: 50, maxZoom: 14 }); } catch(e) {}
  }, [searchBbox, isLoaded]);

  // 4. BASEMAP SWITCHER
  useEffect(() => {
    if (!map.current || !isLoaded) return;
    let tiles = [];
    if (basemap === 'carto') {
      tiles = ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'];
    } else if (basemap === 'hot') {
      tiles = ['https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'];
    } else if (basemap === 'satellite') {
      tiles = [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.png?access_token=${MB_TOKEN}`];
    }
    const source = map.current.getSource('basemap-source');
    if (source) source.setTiles(tiles);
  }, [basemap, isLoaded]);

  // 5. SELECTION
  useEffect(() => {
    if (!map.current || !isLoaded) return;
    closePopup();
    const selectedId = selectedFeature?.properties?.id;

    // Highlight filter
    map.current.setFilter('footprint-highlight', selectedId ? ['==', ['get', 'id'], selectedId] : ['==', ['get', 'id'], '']);

    // Fly to selected
    if (selectedFeature) {
      try {
        isProgrammaticMove.current = true;
        const bounds = bbox(selectedFeature);
        map.current.fitBounds(bounds, { padding: 50, maxZoom: 18, duration: 1500 });
      } catch (e) {}
    }

    // Dim non-selected footprints
    const fillOpacity = selectedId ? 0.05 : 0.15;
    const lineOpacity = selectedId ? 0.3 : 0.8;
    if (map.current.getLayer('footprint-fill')) map.current.setPaintProperty('footprint-fill', 'fill-opacity', fillOpacity);
    if (map.current.getLayer('footprint-line')) map.current.setPaintProperty('footprint-line', 'line-opacity', lineOpacity);
  }, [selectedFeature, isLoaded]);

  // 6. COG PREVIEW — show selected image directly from S3 via COG protocol
  useEffect(() => {
    if (!map.current || !isLoaded) return;
    const mapInstance = map.current;
    const cogSourceId = 'cog-preview';
    const cogLayerId = 'cog-preview-layer';

    // Remove existing COG layer
    if (mapInstance.getLayer(cogLayerId)) mapInstance.removeLayer(cogLayerId);
    if (mapInstance.getSource(cogSourceId)) mapInstance.removeSource(cogSourceId);

    if (!selectedFeature?.properties?.cog_href) return;

    const cogUrl = selectedFeature.properties.cog_href;

    try {
      mapInstance.addSource(cogSourceId, {
        type: 'raster',
        url: `cog://${cogUrl}`,
        tileSize: 256
      });
      mapInstance.addLayer({
        id: cogLayerId,
        type: 'raster',
        source: cogSourceId,
        paint: { 'raster-opacity': 0.9 }
      }, 'footprint-hover');
    } catch (e) {
      console.warn('[map] COG preview error:', e.message);
    }
  }, [selectedFeature, isLoaded]);

  // 7. HOVER HIGHLIGHT
  useEffect(() => {
    if (!map.current || !isLoaded) return;
    const selectedId = selectedFeature?.properties?.id;
    const showHover = hoveredFeatureId && hoveredFeatureId !== selectedId;
    const hoverFilter = showHover ? ['==', ['get', 'id'], hoveredFeatureId] : ['==', ['get', 'id'], ''];
    map.current.setFilter('footprint-hover', hoverFilter);
    map.current.setFilter('centroid-hover', hoverFilter);
  }, [hoveredFeatureId, selectedFeature, isLoaded]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Preview Toggle */}
      <div className="absolute bottom-8 left-4 z-10">
        <button
          onClick={() => setPreviewsEnabled(!previewsEnabled)}
          className={`px-4 py-2 text-xs font-semibold rounded-md shadow-md border transition-all ${
            previewsEnabled
              ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {previewsEnabled ? 'COG Preview On' : 'COG Preview Off'}
        </button>
      </div>
    </div>
  );
}

export default OamMap;
