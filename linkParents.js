const fs = require('fs');
const turf = require('@turf/turf');

// ==== CONFIGURATION ====
const parentFile = 'geoBoundaries-IND-ADM0_simplified.geojson';  // or your parent file
const childFile = 'geoBoundaries-IND-ADM1_simplified.geojson';   // or your child file
const outputFile = 'adm1_with_parent_and_bbox.json';

// === Helper: flatten MultiPolygon/Polygon ===
function getPolygons(feature) {
  if (feature.geometry.type === 'Polygon') {
    return [feature];
  } else if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.map(coords => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: {
        type: 'Polygon',
        coordinates: coords,
      },
    }));
  }
  return [];
}

// === Main logic ===
const parent = JSON.parse(fs.readFileSync(parentFile));
const child = JSON.parse(fs.readFileSync(childFile));

let matched = 0;

child.features.forEach(childFeature => {
  // Assign bbox
  childFeature.bbox = turf.bbox(childFeature);  // [minX, minY, maxX, maxY]

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
            matched++;
            foundParent = true;
            break;
          }
        } catch (e) {
          // Geometry quirks sometimes trigger errors—safe to ignore
        }
      }
      if (foundParent) break;
    }
    if (foundParent) break;
  }
  if (!foundParent) {
    childFeature.properties.parent_id = null;
    childFeature.properties.parent_name = null;
    console.warn('No parent for:', childFeature.properties.shapeName || childFeature.properties.shapename);
  }
});

console.log(`Matched: ${matched} of ${child.features.length} features.`);

// === Write Output ===
fs.writeFileSync(outputFile, JSON.stringify(child, null, 2), 'utf-8');
console.log(`Done! Output written to ${outputFile}`);
