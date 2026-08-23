/** @jest-environment node */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.evidence_safe_semantics_bridge.js'),
  'utf8'
);

function installBridge(UA) {
  const fakeWindow = { UA };
  new Function('window', SOURCE)(fakeWindow);
  return fakeWindow.UA;
}

function report() {
  return {
    structured: { methodikScope: { lines: [] } },
    text: 'Narrative',
    html: '<p>Narrative</p>',
  };
}

describe('issue #644 report background-render recovery', () => {
  test('schedules one ordinary store render when report preparation leaves lifecycle rendering', async () => {
    const dispatch = jest.fn();
    const ctx = { store: { dispatch } };
    const UA = installBridge({
      lifecycle: { getSnapshot: () => ({ status: 'rendering' }) },
    });
    UA.computeExportReport = jest.fn(async () => report());

    const result = await UA.computeExportReport(ctx);

    expect(result.__uaEvidenceSafe644BridgeProcessed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('filtersChanged');
  });

  test('does not render again when lifecycle is already ready', async () => {
    const dispatch = jest.fn();
    const UA = installBridge({
      lifecycle: { getSnapshot: () => ({ status: 'ready' }) },
    });
    UA.computeExportReport = async () => report();

    await UA.computeExportReport({ store: { dispatch } });

    expect(dispatch).not.toHaveBeenCalled();
  });

  test('uses the legacy render path only when no store is available', async () => {
    const renderLayers = jest.fn();
    const ctx = { _dataChanged: false };
    const UA = installBridge({
      lifecycle: { getSnapshot: () => ({ status: 'rendering' }) },
      renderLayers,
    });
    UA.computeExportReport = async () => report();

    await UA.computeExportReport(ctx);

    expect(ctx._dataChanged).toBe(true);
    expect(renderLayers).toHaveBeenCalledTimes(1);
    expect(renderLayers).toHaveBeenCalledWith(ctx);
  });
});
