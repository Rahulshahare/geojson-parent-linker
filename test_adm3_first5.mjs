import fs from 'fs';
import { bbox, booleanWithin, booleanIntersects, booleanOverlap } from '@turf/turf';
import RBush from 'rbush';

const adm1File = 'geoBoundaries-IND-ADM1_simplified.geojson';
const adm2File = 'adm2_with_parent_streamed.geojson';
const adm3File = 'geoBoundaries-IND-ADM3_simplified.geojson';

try {
  if (!fs.existsSync(adm1File)) throw new Error(`ADM1 file ${adm1File} not found`);
  if (!fs.existsSync(adm2File)) throw new Error(`ADM2 file ${adm2File} not found`);
  if (!fs.existsSync(adm3File)) throw new Error(`ADM3 file ${adm3File} not found`);

  // Load data
  const adm1Data = JSON.parse(fs.readFileSync(adm1File));
  const adm2Data = JSON.parse(fs.readFileSync(adm2File));
  const adm3Data = JSON.parse(fs.readFileSync(adm3File));

  // Build spatial index for ADM1
  const adm1Tree = new RBush();
  const adm1Boxes = adm1Data.features.map((feature, index) => {
    try {
      const box = bbox(feature);
      return { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3], index, shapeName: feature.properties.shapeName };
    } catch (e) {
      console.warn(`BBox error for ADM1 feature ${index + 1}: ${e.message}`);
      return null;
    }
  }).filter(box => box !== null);
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
    try { 
      box = bbox(childFeature); 
    } catch (e) {
      console.warn(`BBox failed for ADM3 feature ${childFeature.properties.shapeID || index + 1}: ${e.message}`);
      return;
    }

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
              childFeature.properties.parent_state = matchedState;
              console.log(`ADM3 ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}) belongs to ADM1: ${matchedState}`);
              break;
            }
          } catch (e) {
            console.warn(`ADM1 spatial check failed for ADM3 ${childFeature.properties.shapeID || index + 1}: ${e.message}`);
            continue;
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
                  childFeature.properties.parent_id = adm2Feature.properties.shapeID;
                  childFeature.properties.parent_name = adm2Feature.properties.shapeName;
                  console.log(`  Matched to ADM2: ${adm2Feature.properties.shapeName} (ID: ${adm2Feature.properties.shapeID})`);
                  console.log(`  Final parent_id: ${adm2Feature.properties.shapeID}, parent_name: ${adm2Feature.properties.shapeName}`);
                  foundParent = true;
                }
              }
            } catch (e) {
              console.warn(`ADM2 spatial check failed for ADM3 ${childFeature.properties.shapeID || index + 1}: ${e.message}`);
              continue;
            }
            if (foundParent) break;
          }
          if (foundParent) break;
        }
        if (foundParent) break;
      }
      if (!foundParent) {
        childFeature.properties.parent_name = matchedState;
        childFeature.properties.state_name = matchedState;
        console.log(`  No ADM2 match for ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}), setting parent_name: "${matchedState}", state_name: ${matchedState}`);
      }
    } else {
      console.warn(`No ADM1 match for ADM3 feature ${childFeature.properties.shapeID || index + 1}`);
    }
  }

  // Process only first 10 ADM3 features
  console.log('Testing first 10 ADM3 features...');
  const first10Features = adm3Data.features.slice(0, 10);
  
  // Calculate overall bounding box for the 10 features
  let overallBbox = [Infinity, Infinity, -Infinity, -Infinity];
  
  first10Features.forEach((feature, index) => {
    processFeature(feature, index);
    
    // Update overall bounding box
    try {
      const featureBbox = bbox(feature);
      overallBbox[0] = Math.min(overallBbox[0], featureBbox[0]);
      overallBbox[1] = Math.min(overallBbox[1], featureBbox[1]);
      overallBbox[2] = Math.max(overallBbox[2], featureBbox[2]);
      overallBbox[3] = Math.max(overallBbox[3], featureBbox[3]);
    } catch (e) {
      console.warn(`BBox calculation failed for feature ${index + 1}: ${e.message}`);
    }
  });

  // Create output with processed features
  const outputFeatures = first10Features.map(f => ({
    type: 'Feature',
    properties: {
      shapeID: f.properties.shapeID,
      shapeName: f.properties.shapeName,
      parent_id: f.properties.parent_id || null,
      parent_name: f.properties.parent_name || null,
      state_name: f.properties.state_name || null,
      parent_state: f.properties.parent_state || null
    },
    geometry: f.geometry
  }));

  // Write output to file with bounding box
  const outputData = {
    type: "FeatureCollection",
    features: outputFeatures,
    bbox: overallBbox
  };

  fs.writeFileSync('output.geojson', JSON.stringify(outputData, null, 2));
  console.log('Test completed for first 10 ADM3 features');
  console.log('Overall bbox:', overallBbox);
  console.log('Output written to output.geojson');

} catch (error) {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
}