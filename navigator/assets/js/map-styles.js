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
    ofm_3d: {
        label: 'OpenFreeMap 3D',
        vector: true,
        remoteStyle: 'https://tiles.openfreemap.org/styles/liberty',
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

            ...LIBERTY_ROADS,

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
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font],
                'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 12.5, 18, 15],
                'symbol-placement': 'line',
                'text-rotation-alignment': 'map',
                'text-padding': 2 },
              paint: { 'text-color': '#666666', 'text-halo-color': '#ffffff',
                'text-halo-width': 1, 'text-halo-blur': 0.5 } },

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

    if (style.remoteStyle) return style.remoteStyle;

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

// Дорожная сетка из стиля OpenMapTiles Liberty (как на gdebenz.ru), без спрайтовых слоёв.
// Сгенерировано из style-liberty.20260802.json: туннели + дороги + мосты + ж/д.
const LIBERTY_ROADS = [
  {"id":"tunnel_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"tunnel_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"tunnel_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"tunnel_street_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["street","street_limited"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,15]}},
  {"id":"tunnel_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"tunnel_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"tunnel_motorway_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"tunnel_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"tunnel"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.75],"line-width":["interpolate",["exponential",1.2],["zoom"],14,0.5,20,10]}},
  {"id":"tunnel_motorway_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"tunnel_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"tunnel_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"tunnel_minor","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["minor"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,11.5]}},
  {"id":"tunnel_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,7,0.5,20,10]}},
  {"id":"tunnel_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"tunnel_motorway","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#ffdaa6","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"tunnel_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["rail"],true,false]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"tunnel_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"tunnel_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["transit"],true,false]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"tunnel_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"road_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":12,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"road_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["service","track"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#cfcdca","line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"road_link_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":13,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["motorway","path","pedestrian","service","track"],false,true],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"road_minor_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["minor"],true,false],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#cfcdca","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,20]}},
  {"id":"road_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["secondary","tertiary"],true,false],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"road_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"road_motorway_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":5,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"road_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","minzoom":14,"filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["path","pedestrian"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.7],"line-width":["interpolate",["exponential",1.2],["zoom"],14,1,20,10]}},
  {"id":"road_motorway_link","type":"line","source":"omt","source-layer":"transportation","minzoom":12,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"road_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["service","track"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"road_link","type":"line","source":"omt","source-layer":"transportation","minzoom":13,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","ramp"],1],["match",["get","class"],["motorway","path","pedestrian","service","track"],false,true]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"road_minor","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["minor"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,18]}},
  {"id":"road_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,8,0.5,20,13]}},
  {"id":"road_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"road_motorway","type":"line","source":"omt","source-layer":"transportation","minzoom":5,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":["interpolate",["linear"],["zoom"],5,"hsl(26,87%,62%)",6,"#fc8"],"line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"road_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"road_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"road_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"road_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"bridge_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"bridge_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"bridge_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"link"],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"bridge_street_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["street","street_limited"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"hsl(36,6%,74%)","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,25]}},
  {"id":"bridge_path_pedestrian_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"bridge"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(35,6%,80%)","line-dasharray":[1,0],"line-width":["interpolate",["exponential",1.2],["zoom"],14,1.5,20,18]}},
  {"id":"bridge_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"bridge_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"bridge_motorway_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"bridge_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"bridge"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.3],"line-width":["interpolate",["exponential",1.2],["zoom"],14,0.5,20,10]}},
  {"id":"bridge_motorway_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"bridge_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"bridge_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"link"],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"bridge_street","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["minor"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,18]}},
  {"id":"bridge_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,7,0.5,20,10]}},
  {"id":"bridge_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"bridge_motorway","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"bridge_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"rail"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"bridge_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"rail"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"bridge_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"transit"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"bridge_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"transit"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}}
];
