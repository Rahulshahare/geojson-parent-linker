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
    if (feature.properties && feature.properties.parent_name) {
      const stateName = feature.properties.parent_name.toLowerCase().normalize('NFKD').replace(/[^\w]/g, '');
      if (!adm2ByState.has(stateName)) adm2ByState.set(stateName, []);
      adm2ByState.get(stateName).push({ index, feature });
    }
  });

  function getPolygons(feature) {
    if (!feature || !feature.geometry) return [];
    if (feature.geometry.type === 'Polygon') return [feature];
    if (feature.geometry.type === 'MultiPolygon') {
      return feature.geometry.coordinates.map(coords => ({
        type: 'Feature',
        properties: feature.properties || {},
        geometry: { type: 'Polygon', coordinates: coords }
      }));
    }
    return [];
  }

  function processFeature(childFeature, index) {
    // Ensure feature has required structure
    if (!childFeature || !childFeature.properties || !childFeature.geometry) {
      console.warn(`Invalid feature structure at index ${index + 1}`);
      return;
    }

    let box;
    try { 
      box = bbox(childFeature); 
    } catch (e) {
      console.warn(`BBox failed for ADM3 feature ${childFeature.properties.shapeID || index + 1}: ${e.message}`);
      return;
    }

    const childPolygons = getPolygons(childFeature);
    if (childPolygons.length === 0) {
      console.warn(`No valid polygons for feature ${index + 1}`);
      return;
    }

    let matchedState = null;

    // Step 1: Filter by ADM1
    const adm1Candidates = box ? adm1Tree.search({
      minX: box[0], minY: box[1], maxX: box[2], maxY: box[3]
    }) : adm1Tree.all();

    for (const adm1Candidate of adm1Candidates) {
      const adm1Feature = adm1Data.features[adm1Candidate.index];
      if (!adm1Feature || !adm1Feature.properties) continue;

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
        if (!adm2Feature || !adm2Feature.properties) continue;

        for (const polyChild of childPolygons) {
          for (const polyAdm2 of getPolygons(adm2Feature)) {
            try {
              if (
                booleanWithin(polyChild, polyAdm2) ||
                booleanOverlap(polyChild, polyAdm2) ||
                booleanIntersects(polyChild, polyAdm2)
              ) {
                if (!foundParent) { // Take first match
                  childFeature.properties.parent_id = adm2Feature.properties.shapeID || null;
                  childFeature.properties.parent_name = adm2Feature.properties.shapeName || null;
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
  
  // Validate features before processing
  const validFeatures = first10Features.filter((feature, index) => {
    if (!feature || !feature.properties || !feature.geometry) {
      console.warn(`Skipping invalid feature at index ${index + 1}`);
      return false;
    }
    return true;
  });

  if (validFeatures.length === 0) {
    throw new Error('No valid features found in the first 10 ADM3 features');
  }

  // Calculate overall bounding box for the valid features
  let overallBbox = [Infinity, Infinity, -Infinity, -Infinity];
  
  validFeatures.forEach((feature, index) => {
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

  // Create output with processed features - ensure all required properties exist
  const outputFeatures = validFeatures.map(f => ({
    type: 'Feature',
    properties: {
      shapeID: f.properties.shapeID || null,
      shapeName: f.properties.shapeName || null,
      parent_id: f.properties.parent_id || null,
      parent_name: f.properties.parent_name || null,
      state_name: f.properties.state_name || null,
      parent_state: f.properties.parent_state || null
    },
    geometry: f.geometry || null
  }));

  // Validate bounding box before including it
  const validBbox = overallBbox.every(coord => isFinite(coord));
  
  // Write output to file with proper structure
  const outputData = {
    type: "FeatureCollection",
    features: outputFeatures
  };

  // Only add bbox if it's valid
  if (validBbox) {
    outputData.bbox = overallBbox;
  }

  // Write with error handling
  try {
    fs.writeFileSync('output.geojson', JSON.stringify(outputData, null, 2));
    console.log('Test completed for first 10 ADM3 features');
    if (validBbox) {
      console.log('Overall bbox:', overallBbox);
    }
    console.log('Output written to output.geojson');
    
    // Validate the written file
    const testRead = JSON.parse(fs.readFileSync('output.geojson', 'utf8'));
    console.log('JSON validation successful - file is valid');
    console.log(`Features written: ${testRead.features.length}`);
    
  } catch (writeError) {
    console.error('Error writing or validating output file:', writeError.message);
    throw writeError;
  }

} catch (error) {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
}