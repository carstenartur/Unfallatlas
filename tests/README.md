# Unfallatlas Test Suite

This directory contains comprehensive tests for the Unfallatlas application, covering unit tests, integration tests, end-to-end tests, and performance tests.

## Test Structure

```
tests/
├── unit/                      # Unit tests for individual functions
│   ├── ua.utils.test.js       # Utility function tests (escHtml, normKey, qBool, qFloat)
│   ├── ua.filters.test.js     # Filter logic tests (matchesInvolvementFilter, matchesNonInvolvementFilters)
│   ├── ua.ui.test.js          # UI initialization and state tests
│   └── ua.report_v2.test.js   # Report/export function tests (Word, PDF, crossTable, accidentDetails, deriveDocTitle, buildWerkbankUrl)
├── integration/               # Integration tests for complete workflows
│   ├── export.test.js         # Document export integration tests
│   ├── videoExport.testcontainers.test.js
│   └── locationBriefGoldenCases.testcontainers.test.js
├── e2e/                       # End-to-end tests using Playwright
│   ├── werkbank.spec.js       # User workflow tests
│   ├── smoke.spec.js          # Cross-browser smoke tests (chromium, firefox-smoke, webkit-smoke)
│   ├── accessibility.spec.js  # axe-core accessibility tests (main page + export modal)
│   ├── screenshots.spec.js    # Automated screenshot generation (16 screenshots + PDF render)
│   ├── demo.spec.js           # Demo GIF video generation
│   └── helpers.js             # CDN route interception for offline tests (pdfmake, docx)
├── performance/               # Performance and load tests
│   └── performance.test.js    # Data processing performance tests
└── fixtures/                  # Test data and fixtures
    ├── test_accidents.geojson
    ├── test_pois.geojson
    └── test_references.json
```

## Running Tests

### Prerequisites

Install dependencies:

```bash
npm install
npx playwright install --with-deps
```

### Unit Tests

Run all unit tests:

```bash
npm run test:unit
```

### Integration Tests

Run integration tests:

```bash
npm run test:integration
```

Run the real-data Location Action Brief preflight (Bonn and Hannover,
Docker-free):

```bash
npm run qa:location-brief-golden
```

Run the full persistence and Spring Batch ranking path with Testcontainers:

```bash
npm run test:location-brief-golden:tc
```

See [`docs/location-brief-golden-qa.md`](../docs/location-brief-golden-qa.md)
for the case definitions, interpretation boundary and current reviewed result.

### Performance Tests

Run performance tests:

```bash
npm run test:performance
```

### End-to-End Tests

Run E2E tests with Playwright:

```bash
npm run test:e2e
```

Run E2E tests in headed mode (visible browser):

```bash
npm run test:e2e:headed
```

### Screenshot Generation

The E2E screenshots test (`screenshots.spec.js`) generates all 16 documentation screenshots automatically:

```bash
npx playwright test tests/e2e/screenshots.spec.js --project=chromium
```

Screenshots are saved to `docs/screenshots/`. The GitHub Actions workflow `generate-screenshots.yml` runs this automatically.

### Demo GIF Generation

Generate the demo video for documentation:

```bash
npm run demo
```

This runs the Playwright demo spec which captures a video of the typical analysis workflow.

### All Tests

Run all tests (unit, integration, performance, and E2E):

```bash
npm run test:all
```

### Watch Mode

Run tests in watch mode (automatically re-run on file changes):

```bash
npm run test:watch
```

### Coverage Report

Generate a test coverage report:

```bash
npm run test:coverage
```

Coverage reports will be available in the `coverage/` directory. Open `coverage/lcov-report/index.html` in a browser to view detailed coverage information.

## Test Focus Areas

### Unit Tests

- **Utility Functions** (`ua.utils.test.js`)
  - HTML escaping (XSS prevention)
  - String normalization for city names
  - Query parameter parsing
  - URL manipulation

- **Filter Functions** (`ua.filters.test.js`)
  - 6-bit involvement mask (Rad, Fuß, PKW, Krad, Gkfz, Sonstig)
  - Involvement modes (or, and, solo)
  - Non-involvement filters (severity, time, road condition)

- **UI Functions** (`ua.ui.test.js`)
  - UI element initialization
  - State persistence

- **Report Functions** (`ua.report_v2.test.js`)
  - Map image capture (`captureMapImage`)
  - PDF generation with dynamic title (`deriveDocTitle`)
  - Word document generation with Rahmendaten/Aktive Filter
  - Cross-table (Beteiligungskombination × Schweregrad) in Word + PDF
  - Accident details table in Word + PDF
  - Emoji-to-text replacement for PDF (Gkfz, Sonstig)
  - `buildWerkbankUrl` with all 6 involvement filters
  - Detail map capture with `fitBounds`

### Integration Tests

- **Document Export** (`export.test.js`)
  - Complete PDF generation with test data
  - Complete Word document generation
  - Map image integration
  - POI data integration
  - Reference document integration
  - Error handling and graceful degradation

### End-to-End Tests

- **User Workflows** (`werkbank.spec.js`)
  - Page loading and initialization
  - City selection
  - Filter interactions (severity, participation, time)
  - Display mode toggles (cluster, heatmap)
  - Drawing and area selection
  - Export modal opening and interaction
  - Export option selection
  - Word/PDF document download
  - Accessibility features

- **Screenshots** (`screenshots.spec.js`)
  - All 16 documentation screenshots (Startansicht, Stadtauswahl, Filter, Cluster, Heatmap, Legende, Export-Modal, Stundenfilter, Bereich markieren, Auto-Fahrrad-UND, Fahrrad-Alleinunfälle, POI-Schulen, Bonn Hbf, Export-Filterkontext, PDF-Rendered, Antrag-Inhalt)
  - PDF rendering and validation (pdfjs-dist 4.10.38)

- **Demo** (`demo.spec.js`)
  - Automated demo workflow video capture
  - Tile rendering with mock or real OSM tiles

### Performance Tests

- **Data Processing** (`performance.test.js`)
  - Large dataset processing (5000+ points)
  - Filtering performance
  - POI analysis with multiple locations
  - Map marker preparation
  - Report generation speed
  - Memory usage during repeated operations

## Test Data

The `fixtures/` directory contains sample data for testing:

- **test_accidents.geojson**: Sample accident data with various severities and participation types
- **test_pois.geojson**: Sample POI data (schools, kindergartens, childcare facilities)
- **test_references.json**: Sample reference documents

## Continuous Integration

Tests are automatically run via GitHub Actions on:

- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

Workflows:
- `test.yml` – Runs unit, integration, performance, and E2E tests. Also generates documentation screenshots.
- `generate-screenshots.yml` – Dedicated screenshot generation workflow.

See `.github/workflows/test.yml` for the CI configuration.

## Writing New Tests

### Unit Test Example

```javascript
describe('MyFunction', () => {
  test('should do something', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

### E2E Test Example

```javascript
test('should interact with element', async ({ page }) => {
  await page.goto('/werkbank_v2.html');
  const button = page.locator('#myButton');
  await button.click();
  await expect(button).toHaveClass(/active/);
});
```

## Best Practices

1. **Keep tests isolated**: Each test should be independent and not rely on other tests
2. **Use descriptive names**: Test names should clearly describe what is being tested
3. **Mock external dependencies**: Use mocks for browser APIs and external libraries
4. **Test error cases**: Include tests for error handling and edge cases
5. **Maintain test data**: Keep fixture data up-to-date and representative
6. **Run tests before commits**: Ensure all tests pass before committing changes
7. **Use `jest.restoreAllMocks()`**: In `afterEach` when using `jest.spyOn().mockImplementation()`

## Debugging Tests

### Jest Tests

Run a specific test file:

```bash
npm test -- tests/unit/ua.utils.test.js
```

Run tests matching a pattern:

```bash
npm test -- --testNamePattern="normKey"
```

### Playwright Tests

Run with UI mode for debugging:

```bash
npx playwright test --ui
```

Run a specific test:

```bash
npx playwright test tests/e2e/werkbank.spec.js
```

Debug a failing test:

```bash
npx playwright test --debug
```

## Troubleshooting

### Common Issues

1. **Module not found errors**: Run `npm install` to ensure all dependencies are installed

2. **Playwright browsers not installed**: Run `npx playwright install --with-deps`

3. **Port already in use**: The test server runs on port 8000. Make sure no other process is using this port

4. **Tests timing out**: Increase timeout in test configuration or check for network issues

5. **Screenshot changes after E2E**: Running E2E tests may regenerate `docs/screenshots/` with different sizes from headless rendering. Revert if not intentionally updated.

## Contributing

When adding new features:

1. Write tests first (TDD approach recommended)
2. Ensure all existing tests still pass
3. Add integration tests for new workflows
4. Update E2E tests if UI changes are made
5. Run the full test suite before submitting PR

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
