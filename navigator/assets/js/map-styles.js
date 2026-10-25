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
    },
    nn_3d: {
        label: 'Нижегородская обл. 3D',
        vector: true,
        omt: true,
        attribution: OSM_ATTRIBUTION,
        pmtiles: 'https://storage.yandexcloud.net/nn-map-tiles/nn-omt.pmtiles',
        glyphs: 'https://storage.yandexcloud.net/nn-map-tiles/fonts/{fontstack}/{range}.pbf',
        font: 'NotoSansRegular',
        fontBold: 'NotoSansBold'
    }
};

function omtStyleDefinition(style) {
    const font = style.font || 'NotoSansRegular';
    const fontBold = style.fontBold || 'NotoSansBold';
    const S = 'omt';

    return {
        version: 8,
        glyphs: style.glyphs,
        sources: {
            [S]: {
                type: 'vector',
                url: 'pmtiles://' + style.pmtiles,
                minzoom: 0,
                maxzoom: 14,
                attribution: style.attribution || OSM_ATTRIBUTION
            }
        },
        layers: [
            { id: 'omt-bg', type: 'background', paint: { 'background-color': '#f7f4ef' } },

            { id: 'omt-landcover', type: 'fill', source: S, 'source-layer': 'landcover',
              paint: { 'fill-color': ['match', ['get', 'class'],
                ['wood', 'forest'], '#cfe0c3',
                ['grass', 'meadow'], '#d8e8c8',
                ['farmland'], '#eef0d8',
                ['sand', 'beach'], '#f4ecd3',
                ['wetland'], '#d4e7dc',
                ['ice', 'glacier'], '#eef4f7',
                'rgba(0,0,0,0)'], 'fill-opacity': 0.8 } },

            { id: 'omt-landuse', type: 'fill', source: S, 'source-layer': 'landuse',
              paint: { 'fill-color': ['match', ['get', 'class'],
                ['residential', 'suburb', 'neighbourhood'], '#ebe6df',
                ['commercial', 'retail'], '#efe2e8',
                ['industrial', 'railway', 'quarry'], '#e6e2dd',
                ['cemetery'], '#dfe7da',
                ['park', 'garden', 'playground', 'pitch'], '#d8e8c8',
                'rgba(0,0,0,0)'], 'fill-opacity': 0.7 } },

            { id: 'omt-water', type: 'fill', source: S, 'source-layer': 'water',
              paint: { 'fill-color': '#a6cfe1' } },

            { id: 'omt-waterway', type: 'line', source: S, 'source-layer': 'waterway',
              minzoom: 9,
              paint: { 'line-color': '#a6cfe1',
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 3] } },

            { id: 'omt-boundary', type: 'line', source: S, 'source-layer': 'boundary',
              filter: ['<=', ['to-number', ['get', 'admin_level'], 99], 6],
              paint: { 'line-color': '#9c8fb0',
                'line-width': ['case', ['<=', ['to-number', ['get', 'admin_level'], 99], 4], 1.5, 0.8],
                'line-dasharray': [3, 2] } },

            { id: 'omt-road-casing', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 6,
              filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#e0dbd3',
                'line-width': ['interpolate', ['linear'], ['zoom'],
                  6, ['match', ['get', 'class'], ['motorway', 'trunk'], 2, 1],
                  14, ['match', ['get', 'class'], ['motorway', 'trunk'], 15, 9]] } },

            { id: 'omt-road-major', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 6,
              filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': ['match', ['get', 'class'],
                  'motorway', '#e79a52',
                  'trunk', '#f0b45f',
                  '#f7d489'],
                'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 10, 3, 14, 10] } },

            { id: 'omt-road-medium', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 9,
              filter: ['match', ['get', 'class'], ['secondary', 'tertiary', 'minor'], true, false],
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#ffffff',
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 12, 1.5, 14, 6] } },

            { id: 'omt-road-local', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 12,
              filter: ['match', ['get', 'class'], ['service', 'track', 'residential', 'unclassified', 'living_street'], true, false],
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#ffffff',
                'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 14, 3] } },

            { id: 'omt-road-path', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 13,
              filter: ['match', ['get', 'class'], ['path', 'footway', 'cycleway', 'steps', 'pedestrian', 'bridleway'], true, false],
              paint: { 'line-color': '#c9ab90',
                'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 14, 1.2],
                'line-dasharray': [2, 2] } },

            { id: 'omt-rail', type: 'line', source: S, 'source-layer': 'transportation',
              minzoom: 9, filter: ['==', ['get', 'class'], 'rail'],
              paint: { 'line-color': '#9aa3ad', 'line-width': 1, 'line-dasharray': [4, 3] } },

            { id: 'omt-building', type: 'fill', source: S, 'source-layer': 'building',
              minzoom: 14,
              paint: { 'fill-color': '#dcd5cc',
                'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1] } },

            { id: 'omt-building-3d', type: 'fill-extrusion', source: S, 'source-layer': 'building',
              minzoom: 14.5,
              filter: ['!=', ['get', 'hide_3d'], true],
              paint: {
                'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 4],
                  0, '#e3ddd5', 20, '#d7cfc5', 60, '#c8bdb1', 150, '#b3a89b'],
                'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 4],
                'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                'fill-extrusion-opacity': 0.92,
                'fill-extrusion-vertical-gradient': true
              } },

            { id: 'omt-place', type: 'symbol', source: S, 'source-layer': 'place',
              minzoom: 4,
              filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb', 'neighbourhood'], true, false],
              layout: {
                'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [fontBold],
                'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 9, 13, 14, 16],
                'text-anchor': 'top', 'text-offset': [0, 0.4]
              },
              paint: { 'text-color': '#232c35', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } },

            { id: 'omt-water-name', type: 'symbol', source: S, 'source-layer': 'water_name',
              minzoom: 12,
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font], 'text-size': 11, 'symbol-placement': 'line' },
              paint: { 'text-color': '#3f8aab', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } },

            { id: 'omt-road-name', type: 'symbol', source: S, 'source-layer': 'transportation_name',
              minzoom: 12,
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'ref']],
                'text-font': [font], 'text-size': 10.5, 'symbol-placement': 'line', 'text-padding': 2 },
              paint: { 'text-color': '#4f5b66', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } },

            { id: 'omt-housenumber', type: 'symbol', source: S, 'source-layer': 'housenumber',
              minzoom: 16,
              layout: { 'text-field': ['get', 'housenumber'], 'text-font': [font], 'text-size': 9 },
              paint: { 'text-color': '#6b7480', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } },

            { id: 'omt-poi', type: 'symbol', source: S, 'source-layer': 'poi',
              minzoom: 16,
              filter: ['has', 'name'],
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font], 'text-size': 10, 'text-anchor': 'top', 'text-offset': [0, 0.3] },
              paint: { 'text-color': '#5a6068', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } }
        ]
    };
}

function mapStyleDefinition(type) {
    const styleKey = MAP_STYLES[type] ? type : 'yandex_sat';
    const style = MAP_STYLES[styleKey];

    if (style.omt) return omtStyleDefinition(style);

    if (style.vector) {
        const font = style.font || 'Open Sans Semibold';
        const vectorSource = style.pmtiles
            ? {
                type: 'vector',
                url: 'pmtiles://' + style.pmtiles,
                minzoom: 0,
                maxzoom: 14,
                attribution: style.attribution || OSM_ATTRIBUTION
            }
            : {
                type: 'vector',
                tiles: ['https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'],
                minzoom: 0,
                maxzoom: 14,
                attribution: OSM_ATTRIBUTION
            };
        return {
            version: 8,
            glyphs: style.glyphs || 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
            sources: {
                shortbread: vectorSource
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
                        'text-font': [font],
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
                        'text-font': [font],
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
                        'text-font': [font],
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
