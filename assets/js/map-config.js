// assets/js/map-config.js
const MAP_CONFIG = {
  // MapTiler Cloud ключ
  MAPTILER_KEY: 'mveDsz0PeGC3zhA47AdM',

  // Стили MapTiler
  styles: {
    // Векторная схема (основа для навигатора)
    streets: 'https://api.maptiler.com/maps/streets-v2/style.json?key=',
    // Спутник + векторные надписи (гибрид)
    hybrid: 'https://api.maptiler.com/maps/hybrid/style.json?key=',
    // 3D здания (для tilt 60°)
    '3d-buildings': 'https://api.maptiler.com/maps/3d-buildings/style.json?key=',
    // Базовая схема (легче)
    basic: 'https://api.maptiler.com/maps/basic-v2/style.json?key=',
    // Полная схема с relief
    'streets-relief': 'https://api.maptiler.com/maps/streets-relief-v2/style.json?key=',
  },

  // Дефолтный стиль для навигатора
  defaultStyle: 'streets',
};

// Хелпер для получения полного URL стиля
function getStyleUrl(styleName = MAP_CONFIG.defaultStyle) {
  const base = MAP_CONFIG.styles[styleName] || MAP_CONFIG.styles.streets;
  return base + MAP_CONFIG.MAPTILER_KEY;
}

// Экспорт для модулей
window.MAP_CONFIG = MAP_CONFIG;
window.getStyleUrl = getStyleUrl;