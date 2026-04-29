const mapDiv = document.getElementById('map');
const mapToken = mapDiv.dataset.token;
const coordinates = [parseFloat(mapDiv.dataset.lng), parseFloat(mapDiv.dataset.lat)];

mapboxgl.accessToken = mapToken;

const map = new mapboxgl.Map({
    container: 'map', // container ID
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: coordinates,
    zoom: 5, // Start slightly zoomed out for the animation
    pitch: 0
});

// 1. Add Navigation Controls (Zoom in/out/rotate buttons)
map.addControl(new mapboxgl.NavigationControl(), 'top-right');

map.on('load', () => {
    // 2. Cinematic Fly-In Animation
    map.flyTo({
        center: coordinates,
        zoom: 13,
        pitch: 45, // Tilts the camera for a 3D drone-shot vibe
        duration: 3000, // 3-second smooth animation
        essential: true
    });

    // 3. Privacy Circle
    map.addSource('location-circle', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: coordinates
            }
        }
    });

    map.addLayer({
        id: 'location-circle-fill',
        type: 'circle',
        source: 'location-circle',
        paint: {
            // Shrunken radius (approx 500m)
            'circle-radius': [
                'interpolate',
                ['exponential', 2],
                ['zoom'],
                10, 5,
                22, 20480
            ],
            'circle-opacity': 0.1,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ff385c',
            'circle-pitch-alignment': 'map'
        }
    });
});

// 4. Marker
const marker1 = new mapboxgl.Marker({ color: "red" })
    .setLngLat(coordinates)
    .addTo(map);