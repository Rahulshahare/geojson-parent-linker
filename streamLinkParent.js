const fs = require('fs');
const readline = require('readline');
const turf = require('@turf/turf');

// Set your file names and parent data (still loaded in memory)
const parentFile = 'geoBoundaries-IND-ADM0_simplified.geojson';
const childFile = 'geoBoundaries-IND-ADM1_simplified.geojson';
const outputFile = 'adm1_with_parent_streamed.geojson';

const parent = JSON.parse(fs.readFileSync(parentFile));

// Helper function for flattening polygons
function getPolygons(feature) {
  if (feature.geometry.type === 'Polygon') return [feature];
  if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.map(coords => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: { type: 'Polygon', coordinates: coords }
    }));
  }
  return [];
}

(async function processLargeGeoJSON() {
  // Prepare to write start/FeatureCollection
  fs.writeFileSync(outputFile, '{"type":"FeatureCollection","features":[\n');

  // Read line by line (assumes "features" array, one feature per line, like NDJSON)
  // If your file is standard GeoJSON (array, not NDJSON), first use a tool (like jq or mapshaper) to NDJSON-ify it,
  // OR read the features array in "chunks" as shown below.

  const data = JSON.parse(fs.readFileSync(childFile));
  const features = data.features;

  for(let i=0; i<features.length; i++) {
    let childFeature = features[i];
    childFeature.bbox = turf.bbox(childFeature);

    let foundParent = false;
    const childPolygons = getPolygons(childFeature);

    for (const parentFeature of parent.features) {
      const parentPolygons = getPolygons(parentFeature);
      for (const polyChild of childPolygons) {
        for (const polyParent of parentPolygons) {
          try {
            if (
              turf.booleanWithin(polyChild, polyParent) ||
              turf.booleanOverlap(polyChild, polyParent) ||
              turf.booleanIntersects(polyChild, polyParent)
            ) {
              childFeature.properties.parent_id = parentFeature.properties.shapeID || parentFeature.id;
              childFeature.properties.parent_name = parentFeature.properties.shapeName || parentFeature.properties.shapename;
              foundParent = true;
              break;
            }
          } catch (e) {}
        }
        if (foundParent) break;
      }
      if (foundParent) break;
    }
    if (!foundParent) {
      childFeature.properties.parent_id = null;
      childFeature.properties.parent_name = null;
    }

    // Write the processed feature to the file, with commas between features but not after the last one
    fs.appendFileSync(outputFile, JSON.stringify(childFeature) + (i < features.length - 1 ? ',\n' : '\n'));
    if(i % 100 === 0) console.log(`Processed feature ${i+1} of ${features.length}`);
  }

  // Write the closing of the FeatureCollection
  fs.appendFileSync(outputFile, ']}');
  console.log(`Done! Output written to ${outputFile}`);
})();
