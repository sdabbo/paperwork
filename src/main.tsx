import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { keepAppUpdated } from './lib/appUpdate';
import { hideSplash, initSplash } from './lib/splash';

// The font, and taking the splash screen away when the first screen is there (index.html)
initSplash();

createRoot(document.getElementById('root')!, {
  // A screen that fails to render leaves the page empty: the splash screen doesn't go on waiting for it
  onUncaughtError(error, info) {
    hideSplash();
    console.error(error, info.componentStack);
  },
}).render(<App />);

// Reloads an app that was left open when a newer version is deployed
keepAppUpdated();

// The service worker receives files shared to Paperwork from other apps (see public/sw.js)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}
