import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@/assets/tabi.css';
import { reportColorScheme } from '@/lib/utils/toolbarIcon';

reportColorScheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
