const fs = require('fs');
const readline = require('readline');
const turf = require('@turf/turf');

const parentFile = 'geoBoundaries-IND-ADM1_simplified.geojson';
const childFile = 'geoBoundaries-IND-ADM2_simplified.geojson';
const outputFile = 'adm2_with_parent_streamed.geojson';

if (!fs.existsSync(parentFile) || !fs.existsSync(childFile)) {
  console.error('Error: Input files missing:', { parentFile, childFile });
  process.exit(1);
}

const parent = JSON.parse(fs.readFileSync(parentFile));

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
  try {
    fs.writeFileSync(outputFile, '{"type":"FeatureCollection","features":[\n');
    const data = JSON.parse(fs.readFileSync(childFile));
    const features = data.features;

    for (let i = 0; i < features.length; i++) {
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
            } catch (e) {
              console.warn(`Spatial check failed for feature ${i + 1}:`, e.message);
            }
          }
          if (foundParent) break;
        }
        if (foundParent) break;
      }
      if (!foundParent) {
        childFeature.properties.parent_id = null;
        childFeature.properties.parent_name = null;
        console.warn(`No parent found for ADM1 feature ${i + 1}: ${childFeature.properties.shapeID}`);
      }

      fs.appendFileSync(outputFile, JSON.stringify(childFeature) + (i < features.length - 1 ? ',\n' : '\n'));
      if (i % 100 === 0) console.log(`Processed feature ${i + 1} of ${features.length}`);
    }

    fs.appendFileSync(outputFile, ']}');
    console.log(`Done! Output written to ${outputFile}`);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  }
})();