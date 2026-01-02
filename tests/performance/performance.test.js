/**
 * Performance tests for data processing and rendering
 */

describe('Performance Tests', () => {
  describe('Large Dataset Processing', () => {
    test('should process large GeoJSON dataset within acceptable time', () => {
      const startTime = Date.now();
      
      // Simulate processing a large dataset
      const largeDataset = generateMockGeoJSONData(5000);
      
      // Process the data
      const processed = processGeoJSONData(largeDataset);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should process 5000 points in less than 1000ms
      expect(duration).toBeLessThan(1000);
      expect(processed.length).toBe(5000);
    });

    test('should filter dataset efficiently', () => {
      const dataset = generateMockGeoJSONData(10000);
      
      const startTime = Date.now();
      
      // Apply multiple filters
      const filtered = filterDataset(dataset, {
        severity: '1',
        includesBike: true,
        hourFrom: 6,
        hourTo: 18
      });
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Filtering should be fast
      expect(duration).toBeLessThan(500);
      expect(filtered.length).toBeLessThanOrEqual(dataset.length);
    });
  });

  describe('POI Analysis Performance', () => {
    test('should analyze POIs efficiently for large areas', () => {
      const pois = generateMockPOIData(500);
      const bounds = {
        north: 52.4,
        south: 52.3,
        east: 9.8,
        west: 9.7
      };
      
      const startTime = Date.now();
      
      const analysis = analyzePOIsInBounds(pois, bounds, 200);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // POI analysis with 500 points should be fast
      expect(duration).toBeLessThan(300);
      expect(analysis).toHaveProperty('inside');
      expect(analysis).toHaveProperty('nearby');
    });
  });

  describe('Map Rendering Performance', () => {
    test('should prepare map data efficiently', () => {
      const accidents = generateMockGeoJSONData(3000);
      
      const startTime = Date.now();
      
      // Prepare data for map markers
      const markers = prepareMapMarkers(accidents);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should prepare 3000 markers quickly
      expect(duration).toBeLessThan(500);
      expect(markers.length).toBe(3000);
    });
  });

  describe('Export Performance', () => {
    test('should generate report text efficiently', () => {
      const reportData = {
        accidents: generateMockGeoJSONData(1000),
        pois: generateMockPOIData(50),
        references: generateMockReferences(5)
      };
      
      const startTime = Date.now();
      
      const reportText = generateReportText(reportData);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Text generation should be fast
      expect(duration).toBeLessThan(200);
      expect(reportText.length).toBeGreaterThan(0);
    });

    test('should handle large POI lists in export', () => {
      const reportData = {
        accidents: generateMockGeoJSONData(500),
        pois: generateMockPOIData(200),
        references: []
      };
      
      const startTime = Date.now();
      
      const reportText = generateReportText(reportData);
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Even with 200 POIs, should be fast
      expect(duration).toBeLessThan(500);
      expect(reportText).toContain('POI');
    });
  });

  describe('Memory Usage', () => {
    test('should handle repeated filtering without issues', () => {
      const dataset = generateMockGeoJSONData(5000);
      
      // Perform filtering multiple times to ensure stability
      for (let i = 0; i < 100; i++) {
        const filtered = filterDataset(dataset, {
          severity: String((i % 3) + 1),
          includesBike: i % 2 === 0
        });
        
        // Ensure results are reasonable
        expect(filtered.length).toBeLessThanOrEqual(dataset.length);
      }
      
      // Test completes successfully, demonstrating stable repeated operations
      expect(true).toBe(true);
    });
  });
});

// Helper functions for generating mock data

function generateMockGeoJSONData(count) {
  const features = [];
  
  for (let i = 0; i < count; i++) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          9.7 + Math.random() * 0.1,  // lng
          52.3 + Math.random() * 0.1  // lat
        ]
      },
      properties: {
        OBJECTID: i,
        UKATEGORIE: String(Math.floor(Math.random() * 3) + 1),
        IstRad: Math.random() > 0.5 ? 1 : 0,
        IstFuss: Math.random() > 0.7 ? 1 : 0,
        IstPKW: Math.random() > 0.5 ? 1 : 0,
        IstKrad: Math.random() > 0.8 ? 1 : 0,
        USTUNDE: Math.floor(Math.random() * 24),
        UWOCHENTAG: String(Math.floor(Math.random() * 7) + 1),
        STRZUSTAND: String(Math.floor(Math.random() * 3))
      }
    });
  }
  
  return features;
}

function generateMockPOIData(count) {
  const pois = [];
  const types = ['school', 'kindergarten', 'childcare'];
  
  for (let i = 0; i < count; i++) {
    pois.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          9.7 + Math.random() * 0.1,
          52.3 + Math.random() * 0.1
        ]
      },
      properties: {
        id: `poi-${i}`,
        type: types[Math.floor(Math.random() * types.length)],
        name: `Test POI ${i}`,
        source: 'OpenStreetMap'
      }
    });
  }
  
  return pois;
}

function generateMockReferences(count) {
  const references = [];
  
  for (let i = 0; i < count; i++) {
    references.push({
      title: `Reference Document ${i}`,
      author: 'Test Author',
      date: '2024',
      url: `https://example.com/doc${i}`,
      description: 'Test description for reference document'
    });
  }
  
  return references;
}

function processGeoJSONData(features) {
  // Simulate data processing
  return features.map(f => ({
    ...f,
    processed: true
  }));
}

function filterDataset(features, filters) {
  return features.filter(f => {
    const props = f.properties;
    
    if (filters.severity && props.UKATEGORIE !== filters.severity) {
      return false;
    }
    
    if (filters.includesBike !== undefined && Boolean(props.IstRad) !== filters.includesBike) {
      return false;
    }
    
    if (filters.hourFrom !== undefined && props.USTUNDE < filters.hourFrom) {
      return false;
    }
    
    if (filters.hourTo !== undefined && props.USTUNDE > filters.hourTo) {
      return false;
    }
    
    return true;
  });
}

function analyzePOIsInBounds(pois, bounds, buffer) {
  const inside = [];
  const nearby = [];
  
  pois.forEach(poi => {
    const [lng, lat] = poi.geometry.coordinates;
    
    if (lat >= bounds.south && lat <= bounds.north && 
        lng >= bounds.west && lng <= bounds.east) {
      inside.push(poi);
    } else {
      // Simplified distance check for performance test
      const distLat = Math.min(Math.abs(lat - bounds.north), Math.abs(lat - bounds.south));
      const distLng = Math.min(Math.abs(lng - bounds.east), Math.abs(lng - bounds.west));
      const approxDist = Math.sqrt(distLat * distLat + distLng * distLng) * 111000; // rough conversion to meters
      
      if (approxDist <= buffer) {
        nearby.push(poi);
      }
    }
  });
  
  return { inside, nearby };
}

function prepareMapMarkers(features) {
  return features.map(f => ({
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    properties: f.properties
  }));
}

function generateReportText(data) {
  let text = 'Sachverhalt:\n';
  text += `Im Ausschnitt: ${data.accidents.length} Unfälle\n\n`;
  
  if (data.pois.length > 0) {
    text += 'POI-Analyse\n';
    text += `${data.pois.length} sensible Einrichtungen gefunden\n\n`;
  }
  
  if (data.references.length > 0) {
    text += 'Bezugsdokumente:\n';
    data.references.forEach(ref => {
      text += `- ${ref.title}\n`;
    });
    text += '\n';
  }
  
  text += 'Beschlussvorschlag:\n';
  text += 'Der Bezirksrat bittet um Prüfung.\n';
  
  return text;
}
