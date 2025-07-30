import fs from 'fs';
import { bbox, booleanWithin, booleanIntersects, booleanOverlap } from '@turf/turf';
import RBush from 'rbush';

const adm1File = 'geoBoundaries-IND-ADM1_simplified.geojson';
const adm2File = 'adm2_with_parent_streamed.geojson';
const adm3File = 'geoBoundaries-IND-ADM3_simplified.geojson';

if (!fs.existsSync(adm1File)) {
  console.error(`Error: ADM1 file ${adm1File} not found`);
  process.exit(1);
}
if (!fs.existsSync(adm2File)) {
  console.error(`Error: ADM2 file ${adm2File} not found`);
  process.exit(1);
}
if (!fs.existsSync(adm3File)) {
  console.error(`Error: ADM3 file ${adm3File} not found`);
  process.exit(1);
}

// Load data
const adm1Data = JSON.parse(fs.readFileSync(adm1File));
const adm2Data = JSON.parse(fs.readFileSync(adm2File));
const adm3Data = JSON.parse(fs.readFileSync(adm3File));

// Build spatial index for ADM1
const adm1Tree = new RBush();
const adm1Boxes = adm1Data.features.map((feature, index) => {
  const box = bbox(feature);
  return { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3], index, shapeName: feature.properties.shapeName };
});
adm1Tree.load(adm1Boxes);

// Group ADM2 by parent_name (state), normalizing case
const adm2ByState = new Map();
adm2Data.features.forEach((feature, index) => {
  const stateName = feature.properties.parent_name.toLowerCase().normalize('NFKD').replace(/[^\w]/g, '');
  if (!adm2ByState.has(stateName)) adm2ByState.set(stateName, []);
  adm2ByState.get(stateName).push({ index, feature });
});

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

function processFeature(childFeature, index) {
  let box;
  try { box = bbox(childFeature); } catch (e) { console.warn(`BBox failed for feature ${index + 1}`); }

  const childPolygons = getPolygons(childFeature);
  let matchedState = null;

  // Step 1: Filter by ADM1
  const adm1Candidates = box ? adm1Tree.search({
    minX: box[0], minY: box[1], maxX: box[2], maxY: box[3]
  }) : adm1Tree.all();

  for (const adm1Candidate of adm1Candidates) {
    const adm1Feature = adm1Data.features[adm1Candidate.index];
    for (const polyChild of childPolygons) {
      for (const polyAdm1 of getPolygons(adm1Feature)) {
        try {
          if (booleanWithin(polyChild, polyAdm1) || booleanIntersects(polyChild, polyAdm1)) {
            matchedState = adm1Feature.properties.shapeName;
            console.log(`ADM3 ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}) belongs to ADM1: ${matchedState}`);
            break;
          }
        } catch (error) {
          console.warn(`ADM1 spatial check failed for feature ${index + 1}:`, error.message);
        }
        if (matchedState) break;
      }
      if (matchedState) break;
    }
    if (matchedState) break;
  }

  // Step 2: Match against ADM2 within the state
  let foundParent = false;
  if (matchedState) {
    const normalizedState = matchedState.toLowerCase().normalize('NFKD').replace(/[^\w]/g, '');
    const adm2Candidates = adm2ByState.get(normalizedState) || [];
    console.log(`Debug: Checking ${adm2Candidates.length} ADM2 candidates for ${matchedState}`);
    for (const adm2Candidate of adm2Candidates) {
      const adm2Feature = adm2Candidate.feature;
      for (const polyChild of childPolygons) {
        for (const polyAdm2 of getPolygons(adm2Feature)) {
          try {
            if (
              booleanWithin(polyChild, polyAdm2) ||
              booleanOverlap(polyChild, polyAdm2) ||
              booleanIntersects(polyChild, polyAdm2)
            ) {
              if (!foundParent) { // Take first match
                console.log(`  Matched to ADM2: ${adm2Feature.properties.shapeName} (ID: ${adm2Feature.properties.shapeID})`);
                console.log(`  Final parent_id: ${adm2Feature.properties.shapeID}, parent_name: ${adm2Feature.properties.shapeName}`);
                foundParent = true;
              }
            }
          } catch (error) {
            console.warn(`ADM2 spatial check failed for feature ${index + 1}:`, error.message);
          }
          if (foundParent) break;
        }
        if (foundParent) break;
      }
      if (foundParent) break;
    }
    if (!foundParent) {
      console.log(`  No ADM2 match for ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}), setting parent_name: "", state_name: ${matchedState}`);
    }
  } else if (!matchedState) {
    console.warn(`No ADM1 or ADM2 match for ADM3 feature ${index + 1}: ${childFeature.properties.shapeID || 'unknown'}`);
  }
}

// Process first 5 ADM3 features
console.log('Testing first 5 ADM3 features...');
const first5 = adm3Data.features.slice(0, 5); // Ensured to limit to 5
first5.forEach((feature, index) => processFeature(feature, index));
console.log('Test completed for first 5 ADM3 features');