import React, { useRef, useEffect } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

function MiniMap({ center, bounds }) {
  const mapContainer = useRef(null);
  const map = useRef(null);

  useEffect(() => {
    if (map.current) return;
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm': { type: 'raster', tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'], tileSize: 256, attribution: '' },
          'box': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
        },
        layers: [
          { id: 'osm', type: 'raster', source: 'osm' },
          { id: 'box-line', type: 'line', source: 'box', paint: { 'line-color': '#EF4444', 'line-width': 2 } },
          { id: 'box-fill', type: 'fill', source: 'box', paint: { 'fill-color': '#EF4444', 'fill-opacity': 0.1 } }
        ]
      },
      center: center || [0, 20],
      zoom: 0,
      interactive: false,
      attributionControl: false
    });
  }, []);

  useEffect(() => {
    if (!map.current) return;
    if (center) map.current.setCenter(center);
    if (bounds) {
      const [w, s, e, n] = bounds;
      const source = map.current.getSource('box');
      if (source) {
        source.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[[w, n], [e, n], [e, s], [w, s], [w, n]]] }
        });
      }
    }
  }, [center, bounds]);

  return (
    <div className="relative group">
      <div ref={mapContainer} className="w-32 h-32 border-2 border-white rounded shadow-lg bg-gray-100 pointer-events-none" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
        <div className="w-full h-[1px] bg-black"></div>
        <div className="h-full w-[1px] bg-black absolute"></div>
      </div>
    </div>
  );
}

export default MiniMap;
