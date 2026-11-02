import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/index.css';
import { reloadOnceForChunkError } from './lib/chunk-reload';

// Vite fires this when a lazy chunk (or its preload) fails, e.g. a tab from before the last deploy.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForChunkError()) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
