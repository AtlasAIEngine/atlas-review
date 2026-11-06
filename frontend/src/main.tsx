import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import BackendLoader from './components/BackendLoader.tsx';
import { PopupProvider } from './components/shared/PopupProvider.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BackendLoader>
      <PopupProvider>
        <App />
      </PopupProvider>
    </BackendLoader>
  </React.StrictMode>
);
