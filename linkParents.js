const fs = require('fs');
const fetch = require('node-fetch');
const turf = require('@turf/turf');

// URLs (replace as needed)
const ADM0_URL = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM0/geoBoundaries-IND-ADM0.geojson';
const ADM1_URL = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM1/geoBoundaries-IND-ADM1.geojson';

// Download helper
async function download(url, outfile) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  fs.writeFileSync(outfile, buffer);
  console.log(`Downloaded ${outfile}`);
}

(async () => {
  await download(ADM0_URL, 'adm0.geojson');
  await download(ADM1_URL, 'adm1.geojson');

  const parent = JSON.parse(fs.readFileSync('adm0.geojson'));
  const child = JSON.parse(fs.readFileSync('adm1.geojson'));

  // Output NDJSON file
  const ndjsonOut = fs.createWriteStream('adm1_with_parent.ndjson');
  const outputFeatures = [];

  child.features.forEach(childFeature => {
    childFeature.bbox = turf.bbox(childFeature);

    // Only one country polygon, so direct match:
    childFeature.properties.parent_id = parent.features[0].properties.shapeID || parent.features[0].id;
    childFeature.properties.parent_name = parent.features[0].properties.shapeName || parent.features[0].properties.shapename;

    // Save enriched feature for "full" GeoJSON output
    outputFeatures.push(childFeature);

    // Also output as NDJSON line
    ndjsonOut.write(JSON.stringify(childFeature) + '\n');
  });

  ndjsonOut.end();
  fs.writeFileSync('adm1_with_parent.geojson',
    JSON.stringify({
      type: "FeatureCollection",
      features: outputFeatures
    })
  );
  console.log('Done. Both NDJSON and GeoJSON outputs written.');
})();
