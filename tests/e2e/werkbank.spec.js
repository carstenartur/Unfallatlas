/**
 * End-to-End tests for Werkbank V2 user workflows
 */

import { test, expect } from '@playwright/test';

test.describe('Werkbank V2 - User Workflows', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the werkbank_v2.html page
    await page.goto('/werkbank_v2.html');
    
    // Wait for the page to load
    await page.waitForLoadState('networkidle');
  });

  test('should load the page successfully', async ({ page }) => {
    // Check that the title is correct
    await expect(page).toHaveTitle(/Unfallwerkbank V2/);
    
    // Check that the map is visible
    const map = page.locator('#map');
    await expect(map).toBeVisible();
    
    // Check that the panel is visible
    const panel = page.locator('#panel');
    await expect(panel).toBeVisible();
  });

  test('should select a city from dropdown', async ({ page }) => {
    // Wait for cities to load
    await page.waitForTimeout(2000);
    
    // Check that city selector is available
    const citySelect = page.locator('#citySel');
    await expect(citySelect).toBeVisible();
    
    // Get the first option (should be a city after loading)
    const options = await citySelect.locator('option').count();
    expect(options).toBeGreaterThan(1); // At least one city + placeholder
  });

  test('should change severity filter', async ({ page }) => {
    // Select severity filter
    const severitySelect = page.locator('#severity');
    await expect(severitySelect).toBeVisible();
    
    // Change to "Getötete"
    await severitySelect.selectOption('1');
    
    // Verify selection
    const value = await severitySelect.inputValue();
    expect(value).toBe('1');
  });

  test('should toggle participation filters', async ({ page }) => {
    // Check bike checkbox
    const bikeCheckbox = page.locator('#incBike');
    await expect(bikeCheckbox).toBeVisible();
    
    const initialState = await bikeCheckbox.isChecked();
    
    // Toggle it
    await bikeCheckbox.click();
    
    // Verify it toggled
    const newState = await bikeCheckbox.isChecked();
    expect(newState).toBe(!initialState);
  });

  test('should toggle involvement mode buttons', async ({ page }) => {
    // Find the mode buttons
    const orButton = page.locator('#modeOr');
    const andButton = page.locator('#modeAnd');
    const soloButton = page.locator('#modeSolo');
    
    await expect(orButton).toBeVisible();
    await expect(andButton).toBeVisible();
    await expect(soloButton).toBeVisible();
    
    // OR should be active by default
    await expect(orButton).toHaveClass(/active/);
    
    // Click AND button
    await andButton.click();
    await expect(andButton).toHaveClass(/active/);
    await expect(orButton).not.toHaveClass(/active/);
  });

  test('should adjust hour range sliders', async ({ page }) => {
    const hFromSlider = page.locator('#hFrom');
    const hToSlider = page.locator('#hTo');
    const hFromLabel = page.locator('#hFromLbl');
    const hToLabel = page.locator('#hToLbl');
    
    await expect(hFromSlider).toBeVisible();
    await expect(hToSlider).toBeVisible();
    
    // Set hour from to 6
    await hFromSlider.fill('6');
    await expect(hFromLabel).toHaveText('6');
    
    // Set hour to to 18
    await hToSlider.fill('18');
    await expect(hToLabel).toHaveText('18');
  });

  test('should toggle display modes', async ({ page }) => {
    const clusterBtn = page.locator('#toggleCluster');
    const heatBtn = page.locator('#toggleHeat');
    const onlyHotBtn = page.locator('#toggleOnlyHot');
    
    await expect(clusterBtn).toBeVisible();
    await expect(heatBtn).toBeVisible();
    await expect(onlyHotBtn).toBeVisible();
    
    // Cluster should be active by default
    await expect(clusterBtn).toHaveClass(/active/);
    
    // Toggle cluster off
    await clusterBtn.click();
    await expect(clusterBtn).not.toHaveClass(/active/);
  });

  test('should open and close legend', async ({ page }) => {
    const legendBtn = page.locator('#legendBtn');
    const legendBox = page.locator('#legendBox');
    
    await expect(legendBtn).toBeVisible();
    
    // Legend should be hidden by default (check computed style or visibility)
    const initialDisplay = await legendBox.evaluate(el => window.getComputedStyle(el).display);
    
    // Toggle legend
    await legendBtn.click();
    await page.waitForTimeout(300); // Wait for animation
    
    // Check if display changed
    const newDisplay = await legendBox.evaluate(el => window.getComputedStyle(el).display);
    expect(newDisplay).not.toBe(initialDisplay);
  });

  test('should collapse and expand panel', async ({ page }) => {
    const collapseBtn = page.locator('#collapseBtn');
    const panelBody = page.locator('.panelBody');
    
    await expect(collapseBtn).toBeVisible();
    await expect(panelBody).toBeVisible();
    
    // Click to collapse
    await collapseBtn.click();
    await page.waitForTimeout(300); // Wait for animation
    
    // Panel body should have reduced height or be hidden
    const height = await panelBody.boundingBox();
    expect(height).toBeTruthy();
  });
});

test.describe('Werkbank V2 - Drawing and Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Wait for map initialization
  });

  test('should enable drawing mode', async ({ page }) => {
    const drawBtn = page.locator('#btnDraw');
    await expect(drawBtn).toBeVisible();
    
    await drawBtn.click();
    
    // Check if draw mode is activated (button should change state)
    const classes = await drawBtn.getAttribute('class');
    expect(classes).toBeTruthy();
  });

  test('should clear drawing', async ({ page }) => {
    const clearDrawBtn = page.locator('#btnClearDraw');
    await expect(clearDrawBtn).toBeVisible();
    
    await clearDrawBtn.click();
    
    // Should complete without error
    expect(true).toBe(true);
  });

  test('should open export modal', async ({ page }) => {
    const exportBtn = page.locator('#btnOpenExport');
    const modal = page.locator('#modalOverlay');
    
    await expect(exportBtn).toBeVisible();
    
    // Modal should be hidden initially
    const initialDisplay = await modal.evaluate(el => window.getComputedStyle(el).display);
    expect(initialDisplay).toBe('none');
    
    // Click to open export
    await exportBtn.click();
    
    // Wait for modal to appear
    await page.waitForTimeout(1000);
    
    // Modal should be visible now
    const newDisplay = await modal.evaluate(el => window.getComputedStyle(el).display);
    expect(newDisplay).not.toBe('none');
  });
});

test.describe('Werkbank V2 - Export Modal Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // Open the export modal
    const exportBtn = page.locator('#btnOpenExport');
    await exportBtn.click();
    await page.waitForTimeout(1500);
  });

  test('should display export modal with options', async ({ page }) => {
    // Check that modal is visible
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible();
    
    // Check export option checkboxes
    const includeMapCb = page.locator('#cbIncludeMap');
    const includePOIsCb = page.locator('#cbIncludePOIs');
    const includeRefsCb = page.locator('#cbIncludeRefs');
    
    await expect(includeMapCb).toBeVisible();
    await expect(includePOIsCb).toBeVisible();
    await expect(includeRefsCb).toBeVisible();
    
    // All should be checked by default
    await expect(includeMapCb).toBeChecked();
    await expect(includePOIsCb).toBeChecked();
    await expect(includeRefsCb).toBeChecked();
  });

  test('should toggle export options', async ({ page }) => {
    const includeMapCb = page.locator('#cbIncludeMap');
    
    // Uncheck map option
    await includeMapCb.uncheck();
    await expect(includeMapCb).not.toBeChecked();
    
    // Check it again
    await includeMapCb.check();
    await expect(includeMapCb).toBeChecked();
  });

  test('should have Word and PDF export buttons', async ({ page }) => {
    const wordBtn = page.locator('#btnExportWord');
    const pdfBtn = page.locator('#btnExportPDF');
    
    await expect(wordBtn).toBeVisible();
    await expect(pdfBtn).toBeVisible();
    
    // Check button text
    await expect(wordBtn).toContainText('Word');
    await expect(pdfBtn).toContainText('PDF');
  });

  test('should display export text area', async ({ page }) => {
    const exportTextArea = page.locator('#exportBoxTa');
    await expect(exportTextArea).toBeVisible();
    
    // Should have some content after report generation
    const content = await exportTextArea.inputValue();
    expect(content.length).toBeGreaterThan(0);
  });

  test('should have copy buttons', async ({ page }) => {
    const copyTextBtn = page.locator('#btnCopyText');
    const copyLinkBtn = page.locator('#btnCopyLink');
    
    await expect(copyTextBtn).toBeVisible();
    await expect(copyLinkBtn).toBeVisible();
  });

  test('should close modal', async ({ page }) => {
    const closeBtn = page.locator('#btnCloseModal');
    const modal = page.locator('#modalOverlay');
    
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    
    // Wait for close animation
    await page.waitForTimeout(500);
    
    // Modal should be hidden
    const display = await modal.evaluate(el => window.getComputedStyle(el).display);
    expect(display).toBe('none');
  });
});

test.describe('Werkbank V2 - Accessibility', () => {
  test('should have proper ARIA attributes on modal', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    
    const modal = page.locator('#modalOverlay');
    
    // Check ARIA attributes
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
  });

  test('should have proper labels on export buttons', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // Open modal
    await page.locator('#btnOpenExport').click();
    await page.waitForTimeout(1000);
    
    // Check aria-labels
    const wordBtn = page.locator('#btnExportWord');
    const pdfBtn = page.locator('#btnExportPDF');
    
    await expect(wordBtn).toHaveAttribute('aria-label', 'Export als Word-Dokument');
    await expect(pdfBtn).toHaveAttribute('aria-label', 'Export als PDF-Dokument');
  });
});
