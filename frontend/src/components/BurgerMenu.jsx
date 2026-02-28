import React, { useState } from 'react';

function BurgerMenu() {
  const [isOpen, setIsOpen] = useState(false);

  const menuItems = [
    { label: 'Report Bug / Feedback', href: 'https://github.com/hotosm/cn-oam/issues', icon: 'bug' },
    { label: 'GitHub Repository', href: 'https://github.com/hotosm/cn-oam', icon: 'github' },
    { label: 'Architecture Docs', href: 'https://github.com/hotosm/cn-oam/blob/main/docs/architecture.md', icon: 'info' },
    { type: 'divider' },
    { label: 'Official OAM Browser', href: 'https://map.openaerialmap.org/', icon: 'map', external: true },
  ];

  const getIcon = (name) => {
    const icons = {
      bug: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />,
      info: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
      github: null,
      map: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />,
    };
    if (name === 'github') {
      return <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" /></svg>;
    }
    return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">{icons[name]}</svg>;
  };

  return (
    <div className="absolute top-4 right-4 z-50 font-sans">
      <button onClick={() => setIsOpen(!isOpen)}
        className="w-10 h-10 bg-white rounded shadow-md border border-gray-200 flex items-center justify-center text-gray-600 hover:text-cyan-600 hover:bg-gray-50 transition-all">
        {isOpen ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-12 right-0 w-56 bg-white rounded-lg shadow-xl border border-gray-100 overflow-hidden origin-top-right">
          <div className="py-1">
            {menuItems.map((item, index) => (
              item.type === 'divider' ? (
                <div key={index} className="border-t border-gray-200 my-1" />
              ) : (
                <a key={item.label} href={item.href} target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-cyan-50 hover:text-cyan-700 transition-colors"
                  onClick={() => setIsOpen(false)}>
                  <span className="text-gray-400">{getIcon(item.icon)}</span>
                  <span>{item.label}</span>
                  {item.external && (
                    <svg className="w-3 h-3 ml-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  )}
                </a>
              )
            ))}
          </div>
          <div className="px-4 py-2 bg-cyan-50 border-t border-cyan-100">
            <p className="text-[10px] text-cyan-700 font-medium">
              Cloud-Native OAM Prototype
            </p>
            <p className="text-[9px] text-cyan-600">
              DuckDB-WASM + GeoParquet + COG
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default BurgerMenu;
