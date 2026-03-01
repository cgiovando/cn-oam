import React, { useState, useRef, useCallback, useEffect } from 'react';

const UPLOAD_API_URL = import.meta.env.VITE_UPLOAD_API_URL || '';

const PLATFORMS = ['UAV', 'Satellite', 'Aircraft', 'Balloon/Kite', 'Other'];
const LICENSES = ['CC-BY 4.0', 'CC-BY-SA 4.0', 'CC0 1.0', 'Other'];

const PROCESSING_STEPS = [
  { key: 'downloading', label: 'Downloading image' },
  { key: 'validating', label: 'Validating image' },
  { key: 'converting', label: 'Converting to COG' },
  { key: 'thumbnail', label: 'Generating thumbnail' },
  { key: 'uploading', label: 'Uploading results' },
  { key: 'cataloging', label: 'Updating catalog' },
  { key: 'done', label: 'Complete' },
];

function UploadModal({ isOpen, onClose, onUploadComplete }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState('UAV');
  const [license, setLicense] = useState('CC-BY 4.0');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('cn-oam-api-key') || '');
  const [status, setStatus] = useState('idle'); // idle | requesting | uploading | processing | complete | error
  const [progress, setProgress] = useState(0);
  const [processingStep, setProcessingStep] = useState(null);
  const [error, setError] = useState('');
  const [uploadId, setUploadId] = useState(null);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);
  const dragCountRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // Save API key to localStorage when it changes
  useEffect(() => {
    if (apiKey) localStorage.setItem('cn-oam-api-key', apiKey);
  }, [apiKey]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const resetForm = useCallback(() => {
    setFile(null);
    setTitle('');
    setPlatform('UAV');
    setLicense('CC-BY 4.0');
    setStatus('idle');
    setProgress(0);
    setProcessingStep(null);
    setError('');
    setUploadId(null);
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const handleClose = () => {
    if (status === 'uploading' || status === 'requesting') return;
    resetForm();
    onClose();
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragging(false);
    const dropped = e.dataTransfer.files;
    if (dropped.length > 0) {
      const f = dropped[0];
      if (f.name.match(/\.tiff?$/i)) {
        setFile(f);
        if (!title) setTitle(f.name.replace(/\.tiff?$/i, ''));
      } else {
        setError('Please select a GeoTIFF file (.tif or .tiff)');
      }
    }
  };

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (f) {
      setFile(f);
      if (!title) setTitle(f.name.replace(/\.tiff?$/i, ''));
      setError('');
    }
  };

  const pollStatus = useCallback((id) => {
    const statusUrl = `https://cn-oam.s3.amazonaws.com/uploads/${id}/status.json`;
    let pollCount = 0;
    const maxPolls = 120; // 10 minutes at 5s intervals

    pollRef.current = setInterval(async () => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(pollRef.current);
        setStatus('error');
        setError('Processing timed out. The image may still be processing — check back later.');
        return;
      }
      try {
        const resp = await fetch(statusUrl, { cache: 'no-store' });
        if (resp.ok) {
          const data = await resp.json();
          if (data.step) setProcessingStep(data.step);

          if (data.status === 'complete') {
            clearInterval(pollRef.current);
            setProcessingStep('done');
            setStatus('complete');
            if (onUploadComplete) onUploadComplete(data);
          } else if (data.status === 'error') {
            clearInterval(pollRef.current);
            setStatus('error');
            setError(data.error || 'Processing failed');
          }
        }
      } catch {
        // Status file doesn't exist yet, keep polling
      }
    }, 3000);
  }, [onUploadComplete]);

  const handleUpload = async () => {
    if (!file || !title.trim() || !apiKey.trim()) {
      setError('Please fill in all required fields');
      return;
    }

    if (!UPLOAD_API_URL) {
      setError('Upload API URL not configured');
      return;
    }

    setError('');
    setStatus('requesting');

    try {
      // 1. Request presigned URL
      const params = new URLSearchParams({
        title: title.trim(),
        platform,
        license,
      });
      const authResp = await fetch(`${UPLOAD_API_URL}/upload?${params}`, {
        headers: { 'x-api-key': apiKey },
      });

      if (!authResp.ok) {
        const body = await authResp.json().catch(() => ({}));
        throw new Error(body.error || `Auth failed (${authResp.status})`);
      }

      const { upload_id, presigned_url } = await authResp.json();
      setUploadId(upload_id);
      setStatus('uploading');

      // 2. Upload file directly to S3 via presigned URL
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presigned_url);
        xhr.setRequestHeader('Content-Type', 'image/tiff');

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Upload failed — network error'));
        xhr.send(file);
      });

      // 3. Poll for processing completion
      setStatus('processing');
      setProcessingStep(null);
      pollStatus(upload_id);

    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  };

  if (!isOpen) return null;

  const canSubmit = file && title.trim() && apiKey.trim() && status === 'idle';
  const isWorking = status === 'requesting' || status === 'uploading' || status === 'processing';

  const currentStepIndex = processingStep
    ? PROCESSING_STEPS.findIndex(s => s.key === processingStep)
    : -1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-cyan-500 to-blue-600">
          <h2 className="text-lg font-bold text-white">Upload Imagery</h2>
          <button onClick={handleClose} className="text-white/80 hover:text-white text-2xl leading-none" disabled={isWorking}>
            &times;
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Status displays */}
          {status === 'complete' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
              <div className="text-green-600 font-bold text-lg mb-1">Upload Complete!</div>
              <p className="text-green-700 text-sm">Your image has been processed and will appear in the catalog shortly.</p>
              <button onClick={handleClose} className="mt-3 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium">
                Done
              </button>
            </div>
          )}

          {status !== 'complete' && (
            <>
              {/* Drop zone */}
              <div
                className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                  isDragging ? 'border-cyan-500 bg-cyan-50' : file ? 'border-green-400 bg-green-50' : 'border-gray-300 hover:border-cyan-400 hover:bg-gray-50'
                }`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => !isWorking && fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".tif,.tiff"
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={isWorking}
                />
                {file ? (
                  <div>
                    <div className="text-green-600 font-medium">{file.name}</div>
                    <div className="text-gray-500 text-sm mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB</div>
                  </div>
                ) : (
                  <div>
                    <svg className="w-10 h-10 text-gray-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-gray-600 font-medium">Drop a GeoTIFF here or click to browse</p>
                    <p className="text-gray-400 text-sm mt-1">.tif or .tiff, up to 500MB</p>
                  </div>
                )}
              </div>

              {/* Metadata form — hide during processing to show pipeline */}
              {!isWorking && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Image title"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                      <select
                        value={platform}
                        onChange={(e) => setPlatform(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      >
                        {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">License</label>
                      <select
                        value={license}
                        onChange={(e) => setLicense(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      >
                        {LICENSES.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">API Key *</label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="Your upload API key"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                    />
                  </div>
                </div>
              )}

              {/* Upload progress */}
              {(status === 'requesting' || status === 'uploading') && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 font-medium">
                      {status === 'requesting' && 'Requesting upload...'}
                      {status === 'uploading' && `Uploading to S3... ${progress}%`}
                    </span>
                    {uploadId && <span className="text-gray-400 text-xs font-mono">{uploadId.slice(0, 8)}</span>}
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="h-2 rounded-full transition-all duration-300 bg-cyan-500"
                      style={{ width: `${status === 'requesting' ? 10 : progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Processing pipeline steps */}
              {status === 'processing' && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-700">Processing pipeline</span>
                    {uploadId && <span className="text-gray-400 text-xs font-mono">{uploadId.slice(0, 8)}</span>}
                  </div>
                  <div className="space-y-1">
                    {PROCESSING_STEPS.map((step, i) => {
                      const isActive = step.key === processingStep;
                      const isDone = currentStepIndex > i;
                      const isPending = currentStepIndex < i;
                      const isWaiting = currentStepIndex === -1; // no status yet

                      return (
                        <div key={step.key} className="flex items-center gap-2.5 py-1">
                          {/* Step indicator */}
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                            isDone ? 'bg-green-500' :
                            isActive ? 'bg-amber-500' :
                            'bg-gray-200'
                          }`}>
                            {isDone ? (
                              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            ) : isActive ? (
                              <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
                            ) : null}
                          </div>
                          {/* Step label */}
                          <span className={`text-sm ${
                            isDone ? 'text-green-700 font-medium' :
                            isActive ? 'text-amber-700 font-medium' :
                            'text-gray-400'
                          }`}>
                            {step.label}
                            {isActive && '...'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {currentStepIndex === -1 && (
                    <p className="text-xs text-gray-500">Waiting for processing to start...</p>
                  )}
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
                  {error}
                  {status === 'error' && (
                    <button
                      onClick={() => { setStatus('idle'); setError(''); setProcessingStep(null); }}
                      className="block mt-2 text-red-600 font-medium hover:text-red-800 text-xs"
                    >
                      Try again
                    </button>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm font-medium"
                  disabled={status === 'uploading' || status === 'requesting'}
                >
                  {status === 'processing' ? 'Close' : 'Cancel'}
                </button>
                {!isWorking && (
                  <button
                    onClick={handleUpload}
                    disabled={!canSubmit}
                    className={`px-6 py-2 rounded-lg text-sm font-bold text-white transition-colors ${
                      canSubmit
                        ? 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 shadow-md'
                        : 'bg-gray-300 cursor-not-allowed'
                    }`}
                  >
                    Upload
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default UploadModal;
