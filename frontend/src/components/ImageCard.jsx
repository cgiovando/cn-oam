import React, { useState, useRef, useEffect } from 'react';
import bbox from '@turf/bbox';

// Deterministic color from string hash
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 65%)`;
}

function ImageCard({ feature, onSelect, isSelected }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(null);
  const [thumbError, setThumbError] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    if (isSelected) {
      setIsExpanded(true);
      setTimeout(() => {
        if (cardRef.current) cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    } else {
      setIsExpanded(false);
    }
  }, [isSelected]);

  const p = feature.properties;

  const formatDate = (dateString) => {
    if (!dateString || dateString === 'Unknown Date') return 'Unknown Date';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const formatPlatform = (plat) => {
    if (!plat) return 'Unknown';
    const lower = plat.toLowerCase();
    if (lower === 'uav' || lower === 'drone') return 'Drone';
    return plat.charAt(0).toUpperCase() + plat.slice(1).toLowerCase();
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return 'Unknown';
    const gb = 1073741824;
    const mb = 1048576;
    if (bytes >= gb) return `${(bytes / gb).toFixed(2)} GB`;
    return `${Math.round(bytes / mb)} MB`;
  };

  const formatGsd = (gsd) => {
    if (!gsd) return 'N/A';
    return `${Number(gsd).toFixed(2)} m`;
  };

  const toggleDetails = (e) => { e.stopPropagation(); setIsExpanded(!isExpanded); };
  const handleDeselect = (e) => { e.stopPropagation(); onSelect(null); };
  const handleCopy = (e, text, feedbackId) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopyFeedback(feedbackId);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const handleOpenJosm = async (e) => {
    e.stopPropagation();
    // For COG-based imagery, JOSM can open COGs directly via /vsicurl/
    const cogUrl = p.cog_href;
    if (!cogUrl) return;
    const title = `OAM - ${p.title || p.id}`;
    // Use TMS-style URL if a TiTiler endpoint is configured, otherwise fall back to COG URL
    const josmUrl = `http://127.0.0.1:8111/imagery?title=${encodeURIComponent(title)}&type=tms&url=${encodeURIComponent(cogUrl)}`;
    try { await fetch(josmUrl); } catch (err) {
      alert("Could not connect to JOSM. Make sure JOSM is running and 'Remote Control' is enabled.");
    }
  };

  const handleOpenId = (e) => {
    e.stopPropagation();
    const featureBbox = bbox(feature);
    const centerX = (featureBbox[0] + featureBbox[2]) / 2;
    const centerY = (featureBbox[1] + featureBbox[3]) / 2;
    const idUrl = `https://www.openstreetmap.org/edit?editor=id#map=16/${centerY}/${centerX}`;
    window.open(idUrl, '_blank');
  };

  return (
    <div
      ref={cardRef}
      onClick={() => onSelect(feature)}
      className={`group border-b transition-all duration-200 relative ${
        isSelected
          ? 'bg-white border-l-4 border-l-cyan-500 shadow-md my-2 rounded-r-md'
          : 'border-gray-100 bg-white hover:bg-gray-50 border-l-4 border-l-transparent'
      }`}
    >
      {isSelected && (
        <button onClick={handleDeselect} className="absolute top-2 right-2 text-gray-400 hover:text-cyan-600 p-1 hover:bg-gray-100 rounded-full z-10" title="Deselect">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      )}

      <div className="p-4">
        {/* Thumbnail */}
        <div className="aspect-video bg-gray-100 rounded-md mb-3 overflow-hidden relative border border-gray-200 shadow-inner">
          {(p.thumbnail_href || p.thumbnail) && !thumbError
            ? <img
                src={p.thumbnail_href || p.thumbnail}
                alt="Preview"
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setThumbError(true)}
              />
            : <div
                className="flex flex-col items-center justify-center h-full text-white/90 text-xs gap-1"
                style={{ background: `linear-gradient(135deg, ${hashColor(p.id || '')}, ${hashColor(p.title || '')})` }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="font-medium opacity-80 px-2 text-center leading-tight">{formatPlatform(p.platform_type || p.platform)}</span>
              </div>
          }
        </div>

        {/* Title + Meta */}
        <div className="flex justify-between items-start gap-2 pr-6">
          <h3 className={`font-bold text-sm leading-tight ${isSelected ? 'text-cyan-700' : 'text-gray-800'}`}>
            {p.title}
          </h3>
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-500 mt-2">
          <span className="font-medium text-gray-700">{formatDate(p.datetime || p.date)}</span>
          <span className="text-gray-300">·</span>
          <span className="truncate max-w-[150px]" title={p.producer_name || p.provider}>{p.producer_name || p.provider}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
          <button onClick={toggleDetails} className="flex-1 text-xs font-semibold text-gray-500 hover:text-cyan-600 flex items-center justify-center gap-1 py-1.5 transition-colors">
            {isExpanded ? 'Hide Details' : 'Show Details'}
            <span className="text-[9px] transform transition-transform duration-200" style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>&#x25BC;</span>
          </button>
          {p.cog_href && (
            <a href={p.cog_href} target="_blank" rel="noreferrer" download onClick={(e) => e.stopPropagation()}
              className="flex-1 text-xs font-semibold text-cyan-600 bg-cyan-50 hover:bg-cyan-100 py-1.5 rounded text-center transition-colors">
              Download COG
            </a>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="bg-gray-50 px-4 py-4 text-xs border-t border-gray-100 text-gray-600">
          <div className="mb-4 pb-3 border-b border-gray-200">
            <div className="flex gap-2">
              <button onClick={(e) => handleCopy(e, p.cog_href || '', 'cog')}
                className="flex-1 bg-white border border-gray-300 text-gray-600 py-1.5 rounded hover:bg-gray-100 transition-all shadow-sm">
                {copyFeedback === 'cog' ? <span className="text-green-600 font-bold">Copied!</span> : 'Copy COG URL'}
              </button>
              <button onClick={handleOpenId}
                className="flex-1 bg-white border border-gray-300 text-gray-600 py-1.5 rounded hover:bg-gray-100 transition-all shadow-sm">
                Open iD
              </button>
              <button onClick={handleOpenJosm}
                className="flex-1 bg-white border border-gray-300 text-gray-600 py-1.5 rounded hover:bg-gray-100 transition-all shadow-sm">
                Open JOSM
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-y-3 gap-x-4">
            <div><span className="block text-[10px] uppercase text-gray-400 font-bold">Platform</span>{formatPlatform(p.platform_type || p.platform)}</div>
            <div><span className="block text-[10px] uppercase text-gray-400 font-bold">GSD</span>{formatGsd(p.gsd)}</div>
            <div><span className="block text-[10px] uppercase text-gray-400 font-bold">Size</span>{formatFileSize(p.file_size)}</div>
            <div><span className="block text-[10px] uppercase text-gray-400 font-bold">Dimensions</span>{p.width && p.height ? `${p.width}×${p.height}` : 'Unknown'}</div>
            <div><span className="block text-[10px] uppercase text-gray-400 font-bold">License</span>
              <a href="https://creativecommons.org/licenses/" target="_blank" rel="noreferrer" className="hover:underline hover:text-cyan-600 truncate block" title={p.license}>{p.license}</a>
            </div>
            <div className="min-w-0"><span className="block text-[10px] uppercase text-gray-400 font-bold">ID</span>
              <span className="font-mono text-[10px] text-gray-500 block truncate select-all cursor-text bg-gray-100 px-1 rounded" title={p.id}>{p.id}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ImageCard;
