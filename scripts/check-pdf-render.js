#!/usr/bin/env node
/**
 * scripts/check-pdf-render.js — PR 3 / Spec-Item 12 (Poppler/Ghostscript-Render-Gate)
 *
 * Prüft eine bereits erzeugte PDF-Datei mit den System-Tools Poppler
 * (pdftoppm / pdfimages / pdfinfo) und Ghostscript (gs). Ziel ist, dass
 * jede Seite des PDFs in begrenzter Zeit RENDERBAR ist — ein PDF, das in
 * einem dieser Renderer einfriert oder mit Fehler abbricht, wäre vor Ort
 * im Verwaltungs-Workflow ebenfalls nicht öffenbar.
 *
 * Verhalten:
 *   - Wird ohne Argument aufgerufen, erwartet das Skript die Umgebungs-
 *     variable PDF_PATH oder fällt auf ./out/test.pdf zurück.
 *   - Fehlen die Binaries (Poppler/Ghostscript) lokal, wird das Skript
 *     mit Hinweis übersprungen (Exit-Code 0). Damit lässt sich der
 *     Render-Gate als optionales CI-Stage einplanen, ohne Entwickler-
 *     Maschinen ohne Poppler zu blockieren — die CI-Installation der
 *     Binaries ist Teil eines separaten Reviewprozesses.
 *   - Pro Seite wird ein hartes Timeout erzwungen (default 15 s), damit
 *     hängende Renderer den Build nicht blockieren.
 *
 * CLI-Argumente:
 *   --pdf <path>           Pfad zum PDF (default: $PDF_PATH oder out/test.pdf)
 *   --timeout-per-page <s> Timeout pro Seite in Sekunden (default: 15)
 *   --max-pages <n>        Maximalzahl zu prüfender Seiten (default: 50)
 *   --tool <pdftoppm|pdfimages|gs|all>  Welcher Renderer geprüft wird (default: all)
 *   --quiet                Reduzierte Konsolenausgabe
 *
 * Exit-Codes:
 *   0  alle Seiten in allen verfügbaren Tools innerhalb des Timeouts ok
 *   0  Tools nicht installiert (skip mode)
 *   1  PDF nicht gefunden / Argument ungültig
 *   2  mindestens eine Seite hat in einem Tool gefailt oder timeoutet
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// -------------------- argv parsing --------------------
function parseArgs(argv) {
  const out = {
    pdf: process.env.PDF_PATH || 'out/test.pdf',
    timeoutPerPage: 15,
    maxPages: 50,
    tool: 'all',
    quiet: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pdf') out.pdf = argv[++i];
    else if (a === '--timeout-per-page') out.timeoutPerPage = Number(argv[++i]) || out.timeoutPerPage;
    else if (a === '--max-pages') out.maxPages = Number(argv[++i]) || out.maxPages;
    else if (a === '--tool') out.tool = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write([
    'Usage: node scripts/check-pdf-render.js [--pdf <path>] [--timeout-per-page <s>]',
    '                                        [--max-pages <n>] [--tool <pdftoppm|pdfimages|gs|all>]',
    '                                        [--quiet]',
    '',
    'Defaults: --pdf $PDF_PATH or ./out/test.pdf, --timeout-per-page 15,',
    '          --max-pages 50, --tool all',
    ''
  ].join('\n'));
}

// -------------------- tool detection --------------------
function which(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// -------------------- subprocess helper --------------------
function runWithTimeout(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: -1, signal: null, stderr: String(err && err.message || err), timedOut: false });
      return;
    }
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', () => { /* drain */ });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, code: -1, signal: null, stderr: String(err.message), timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ ok: !timedOut && code === 0, code, signal, stderr: stderr.slice(0, 4000), timedOut });
    });
  });
}

// -------------------- pdfinfo: pageCount --------------------
async function getPageCount(pdfinfo, pdfPath, timeoutMs) {
  const r = await runWithTimeout(pdfinfo, [pdfPath], timeoutMs);
  if (!r.ok) return null;
  // pdfinfo prints "Pages: N" on its own line.
  // We re-run capturing stdout this time (the helper drained stdout); use execFileSync.
  try {
    const out = execFileSync(pdfinfo, [pdfPath], { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).toString();
    const m = out.match(/^Pages:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// -------------------- per-page renderers --------------------
function pdftoppmArgs(pdfPath, pageNum, outDir) {
  return [
    '-r', '72',
    '-f', String(pageNum),
    '-l', String(pageNum),
    '-png',
    pdfPath,
    path.join(outDir, `page-${pageNum}`)
  ];
}

function pdfimagesArgs(pdfPath, pageNum, outDir) {
  return [
    '-list',
    '-f', String(pageNum),
    '-l', String(pageNum),
    pdfPath
  ];
}

function gsArgs(pdfPath, pageNum, outDir) {
  return [
    '-dQUIET',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=nullpage',
    `-dFirstPage=${pageNum}`,
    `-dLastPage=${pageNum}`,
    pdfPath
  ];
}

// -------------------- main --------------------
async function main() {
  const args = parseArgs(process.argv);
  const log = args.quiet ? () => {} : (...a) => process.stdout.write(a.join(' ') + '\n');

  if (!fs.existsSync(args.pdf)) {
    process.stderr.write(`PDF not found: ${args.pdf}\n`);
    process.exit(1);
  }

  const pdftoppm = which('pdftoppm');
  const pdfimages = which('pdfimages');
  const pdfinfo = which('pdfinfo');
  const gs = which('gs');

  const tools = [];
  if ((args.tool === 'all' || args.tool === 'pdftoppm') && pdftoppm) {
    tools.push({ name: 'pdftoppm', bin: pdftoppm, mkArgs: pdftoppmArgs });
  }
  if ((args.tool === 'all' || args.tool === 'pdfimages') && pdfimages) {
    tools.push({ name: 'pdfimages', bin: pdfimages, mkArgs: pdfimagesArgs });
  }
  if ((args.tool === 'all' || args.tool === 'gs') && gs) {
    tools.push({ name: 'gs', bin: gs, mkArgs: gsArgs });
  }

  if (tools.length === 0) {
    log('check-pdf-render: skipping — no Poppler/Ghostscript tools found on PATH.');
    log('  install with `apt-get install poppler-utils ghostscript` (Debian/Ubuntu)');
    log('  or `brew install poppler ghostscript` (macOS) to enable the gate.');
    process.exit(0);
  }

  // Determine page count (prefer pdfinfo; fallback: probe pages 1..maxPages until first failure).
  let pageCount = null;
  if (pdfinfo) {
    pageCount = await getPageCount(pdfinfo, args.pdf, args.timeoutPerPage * 1000);
  }
  if (!pageCount || pageCount < 1) {
    log('check-pdf-render: pdfinfo unavailable or returned no Pages count — using --max-pages as upper bound.');
    pageCount = args.maxPages;
  }
  pageCount = Math.min(pageCount, args.maxPages);

  log(`check-pdf-render: ${args.pdf} (${pageCount} pages, ${tools.length} tool(s), ${args.timeoutPerPage}s/page)`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-render-'));
  let failures = 0;
  try {
    for (const tool of tools) {
      log(`  [${tool.name}] starting per-page render gate`);
      for (let p = 1; p <= pageCount; p++) {
        const r = await runWithTimeout(tool.bin, tool.mkArgs(args.pdf, p, tmpDir), args.timeoutPerPage * 1000);
        if (!r.ok) {
          failures++;
          const reason = r.timedOut
            ? `TIMEOUT after ${args.timeoutPerPage}s`
            : `exit=${r.code}${r.signal ? ' signal=' + r.signal : ''}`;
          process.stderr.write(`  [${tool.name}] page ${p}: FAIL (${reason})\n`);
          if (r.stderr && !args.quiet) {
            process.stderr.write(r.stderr.split('\n').map(l => '      ' + l).join('\n') + '\n');
          }
        } else if (!args.quiet) {
          log(`  [${tool.name}] page ${p}: ok`);
        }
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  if (failures > 0) {
    process.stderr.write(`check-pdf-render: ${failures} failure(s) — see above.\n`);
    process.exit(2);
  }
  log('check-pdf-render: all pages rendered successfully in all available tools.');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write('check-pdf-render: unexpected error: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
