import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { StartupScreen } from './components/StartupScreen';

const isCompanionSurface = new URLSearchParams(window.location.search).get('surface') === 'companion';
if(isCompanionSurface)document.documentElement.dataset.surface='companion';
const Surface=isCompanionSurface?lazy(()=>import('./features/companion/DesktopCompanion').then(module=>({default:module.DesktopCompanion}))):lazy(()=>import('./App').then(module=>({default:module.App})));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={isCompanionSurface?null:<StartupScreen/>}><Surface/></Suspense>
  </StrictMode>
);
