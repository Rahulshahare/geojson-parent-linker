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

  console.log('Loading ADM1:', 'Found');
  let adm1Data;
  try { adm1Data = JSON.parse(fs.readFileSync(adm1File)); } catch (e) { console.error('Failed to parse ADM1:', e.message); throw e; }
  console.log('ADM1 loaded, features count:', adm1Data.features?.length || 'N/A');

  console.log('Loading ADM2:', 'Found');
  let adm2Data;
  try { adm2Data = JSON.parse(fs.readFileSync(adm2File)); } catch (e) { console.error('Failed to parse ADM2:', e.message); throw e; }
  console.log('ADM2 loaded, features count:', adm2Data.features?.length || 'N/A');

  console.log('Loading ADM3:', 'Found');
  let adm3Data;
  try { adm3Data = JSON.parse(fs.readFileSync(adm3File)); } catch (e) { console.error('Failed to parse ADM3:', e.message); throw e; }
  console.log('ADM3 loaded, features count:', adm3Data.features?.length || 'N/A');

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
    if (!childFeature || !childFeature.properties || !childFeature.geometry) {
      console.warn(`Invalid feature structure at index ${index + 1}`);
      return;
    }

    let box;
    try { box = bbox(childFeature); } catch (e) {
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
              if (index < 10) { // Only log first 10 for readability
                console.log(`ADM3 ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}) belongs to ADM1: ${matchedState}`);
              }
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
      if (index < 10) { // Only log first 10 for readability
        console.log(`Debug: Checking ${adm2Candidates.length} ADM2 candidates for ${matchedState}`);
      }

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
                  if (index < 10) { // Only log first 10 for readability
                    console.log(`  Matched to ADM2: ${adm2Feature.properties.shapeName} (ID: ${adm2Feature.properties.shapeID})`);
                    console.log(`  Final parent_id: ${adm2Feature.properties.shapeID}, parent_name: ${adm2Feature.properties.shapeName}`);
                  }
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
        if (index < 10) { // Only log first 10 for readability
          console.log(`  No ADM2 match for ${childFeature.properties.shapeID} (${childFeature.properties.shapeName}), setting parent_name: "${matchedState}", state_name: ${matchedState}`);
        }
      }
    } else {
      console.warn(`No ADM1 match for ADM3 feature ${childFeature.properties.shapeID || index + 1}`);
    }
  }

  // Process all ADM3 features with proper streaming
  const chunkSize = 1000;
  let overallBbox = [Infinity, Infinity, -Infinity, -Infinity];
  let processedCount = 0;
  const totalFeatures = adm3Data.features.length;

  console.log(`Starting processing of ${totalFeatures} ADM3 features...`);

  // Initialize output file
  fs.writeFileSync('adm3_with_parent_streamed.geojson', '{"type":"FeatureCollection","features":[\n');

  for (let i = 0; i < totalFeatures; i += chunkSize) {
    const chunk = adm3Data.features.slice(i, i + chunkSize);
    const actualChunkSize = chunk.length;

    chunk.forEach((feature, chunkIndex) => {
      const globalIndex = i + chunkIndex;
      
      // Validate feature before processing
      if (!feature || !feature.properties || !feature.geometry) {
        console.warn(`Skipping invalid feature at index ${globalIndex + 1}`);
        return;
      }

      processFeature(feature, globalIndex);

      // Update overall bounding box
      try {
        const featureBbox = bbox(feature);
        overallBbox[0] = Math.min(overallBbox[0], featureBbox[0]);
        overallBbox[1] = Math.min(overallBbox[1], featureBbox[1]);
        overallBbox[2] = Math.max(overallBbox[2], featureBbox[2]);
        overallBbox[3] = Math.max(overallBbox[3], featureBbox[3]);
      } catch (e) {
        console.warn(`BBox calculation failed for feature ${globalIndex + 1}: ${e.message}`);
      }

      // Create clean output feature with individual bbox
      let featureBbox = null;
      try {
        featureBbox = bbox(feature);
      } catch (e) {
        console.warn(`Failed to calculate bbox for feature ${globalIndex + 1}: ${e.message}`);
      }

      const outputFeature = {
        type: 'Feature',
        properties: {
          shapeID: feature.properties.shapeID || null,
          shapeName: feature.properties.shapeName || null,
          parent_id: feature.properties.parent_id || null,
          parent_name: feature.properties.parent_name || null,
          state_name: feature.properties.state_name || null,
          parent_state: feature.properties.parent_state || null
        },
        bbox: featureBbox,
        geometry: feature.geometry || null
      };

      // Write individual feature with proper comma separation
      const isLast = globalIndex === totalFeatures - 1;
      const separator = isLast ? '\n' : ',\n';
      fs.appendFileSync('adm3_with_parent_streamed.geojson', JSON.stringify(outputFeature) + separator);

      processedCount++;
    });

    console.log(`Processed chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(totalFeatures / chunkSize)} (${processedCount}/${totalFeatures} features)`);
  }

  // Close features array and add bbox
  const validBbox = overallBbox.every(coord => isFinite(coord));
  if (validBbox) {
    fs.appendFileSync('adm3_with_parent_streamed.geojson', '],"bbox":' + JSON.stringify(overallBbox) + '}');
  } else {
    fs.appendFileSync('adm3_with_parent_streamed.geojson', ']}');
  }

  console.log(`Processing completed for ${processedCount} ADM3 features`);
  if (validBbox) {
    console.log('Overall bbox:', overallBbox);
  }
  console.log('Output written to adm3_with_parent_streamed.geojson');

  // Validate the output file
  try {
    const testRead = JSON.parse(fs.readFileSync('adm3_with_parent_streamed.geojson', 'utf8'));
    console.log('JSON validation successful - file is valid');
    console.log(`Features in output: ${testRead.features.length}`);
    console.log(`BBox included: ${testRead.bbox ? 'Yes' : 'No'}`);
  } catch (validationError) {
    console.error('Output file validation failed:', validationError.message);
  }

} catch (error) {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
}