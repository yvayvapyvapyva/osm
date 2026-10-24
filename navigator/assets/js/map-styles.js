const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
const MAP_STYLES = {
    yandex_sat: {
        label: 'Яндекс.Спутник',
        tiles: ['yandexsat://sat/{z}/{x}/{y}']
    },
    osm: {
        label: 'OSM (растр)',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: OSM_ATTRIBUTION
    },
    osm_vector: {
        label: 'OSM (вектор)',
        vector: true,
        attribution: OSM_ATTRIBUTION
    }
};

function mapStyleDefinition(type) {
    const styleKey = MAP_STYLES[type] ? type : 'yandex_sat';
    const style = MAP_STYLES[styleKey];

    if (style.vector) {
        return {
            version: 8,
            glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
            sources: {
                shortbread: {
                    type: 'vector',
                    tiles: ['https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'],
                    minzoom: 0,
                    maxzoom: 14,
                    attribution: OSM_ATTRIBUTION
                }
            },
            layers: [
                {
                    id: 'osm-background',
                    type: 'background',
                    paint: { 'background-color': '#f2efe9' }
                },
                {
                    id: 'osm-ocean',
                    type: 'fill',
                    source: 'shortbread',
                    'source-layer': 'ocean',
                    paint: { 'fill-color': '#aad3df' }
                },
                {
                    id: 'osm-land',
                    type: 'fill',
                    source: 'shortbread',
                    'source-layer': 'land',
                    paint: { 'fill-color': '#f2efe9' }
                },
                {
                    id: 'osm-water-polygons',
                    type: 'fill',
                    source: 'shortbread',
                    'source-layer': 'water_polygons',
                    paint: { 'fill-color': '#aad3df' }
                },
                {
                    id: 'osm-sites',
                    type: 'fill',
                    source: 'shortbread',
                    'source-layer': 'sites',
                    minzoom: 14,
                    paint: { 'fill-color': '#e6e2d8', 'fill-opacity': 0.7 }
                },
                {
                    id: 'osm-buildings',
                    type: 'fill',
                    source: 'shortbread',
                    'source-layer': 'buildings',
                    minzoom: 14,
                    paint: { 'fill-color': '#d9d0c9' }
                },
                {
                    id: 'osm-boundaries',
                    type: 'line',
                    source: 'shortbread',
                    'source-layer': 'boundaries',
                    paint: { 'line-color': '#a68aa2', 'line-width': 1 }
                },
                {
                    id: 'osm-water-lines',
                    type: 'line',
                    source: 'shortbread',
                    'source-layer': 'water_lines',
                    paint: {
                        'line-color': '#8fc4d5',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2.5]
                    }
                },
                {
                    id: 'osm-streets-casing',
                    type: 'line',
                    source: 'shortbread',
                    'source-layer': 'streets',
                    paint: {
                        'line-color': '#d2cec6',
                        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 14, 5]
                    }
                },
                {
                    id: 'osm-streets',
                    type: 'line',
                    source: 'shortbread',
                    'source-layer': 'streets',
                    paint: {
                        'line-color': [
                            'match', ['get', 'kind'],
                            'motorway', '#e68a91',
                            ['trunk', 'primary'], '#efbd78',
                            ['secondary', 'tertiary'], '#f4d89b',
                            '#ffffff'
                        ],
                        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 14, 3.4]
                    }
                },
                {
                    id: 'osm-street-labels',
                    type: 'symbol',
                    source: 'shortbread',
                    'source-layer': 'street_labels',
                    minzoom: 11,
                    layout: {
                        'symbol-placement': 'line',
                        'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
                        'text-font': ['Open Sans Semibold'],
                        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 12]
                    },
                    paint: {
                        'text-color': '#55534f',
                        'text-halo-color': '#f8f6f1',
                        'text-halo-width': 1
                    }
                },
                {
                    id: 'osm-water-labels',
                    type: 'symbol',
                    source: 'shortbread',
                    'source-layer': 'water_polygons_labels',
                    minzoom: 10,
                    layout: {
                        'text-field': ['get', 'name'],
                        'text-font': ['Open Sans Semibold'],
                        'text-size': 11
                    },
                    paint: {
                        'text-color': '#4f8294',
                        'text-halo-color': '#e7f2f5',
                        'text-halo-width': 1
                    }
                },
                {
                    id: 'osm-place-labels',
                    type: 'symbol',
                    source: 'shortbread',
                    'source-layer': 'place_labels',
                    layout: {
                        'text-field': ['get', 'name'],
                        'text-font': ['Open Sans Semibold'],
                        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 14, 15]
                    },
                    paint: {
                        'text-color': '#4c4a46',
                        'text-halo-color': '#f8f6f1',
                        'text-halo-width': 1.2
                    }
                }
            ]
        };
    }

    const sourceId = styleKey === 'yandex_sat' ? 'osm-yandex-base' : 'osm-raster';
    const rasterSource = {
        type: 'raster',
        tiles: style.tiles,
        tileSize: 256,
        attribution: style.attribution || '© Яндекс'
    };
    if (styleKey === 'osm') rasterSource.maxzoom = 19;
    return {
        version: 8,
        sources: { [sourceId]: rasterSource },
        layers: [{ id: sourceId, type: 'raster', source: sourceId }]
    };
}
