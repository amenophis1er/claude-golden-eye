import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const stored = localStorage.getItem('ge-theme');
const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
