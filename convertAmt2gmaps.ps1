<#
.SYNOPSIS
  Unfallatlas Converter (CSV + GeoJSON) – PowerShell Version

.DESCRIPTION
  Lädt Unfallatlas-Unfallorte pro Jahr (ZIP) von opengeodata.nrw.de, filtert nach Region
  (ULAND/UREGBEZ/UKREIS [+UGEMEINDE]) und Beteiligungsarten (IstRad/IstPKW/IstFuss/IstKrad)
  und erzeugt pro Jahr:
    - out/outputYYYY.csv
    - out/outputYYYY.geojson
  sowie kombiniert:
    - out/output_all_years.csv
    - out/output_all_years.geojson

  Zusatzfelder werden als CSV-Spalten und GeoJSON-properties exportiert:
    UKATEGORIE, UTYP1, UART, UMONAT, USTUNDE, UWOCHENTAG, STRZUSTAND, ULICHTVERH

  Optionaler City-Workflow (>=100k Einwohner) über Cache:
    -UpdateCityCache, -City, -ListCities, -Search
#>

[CmdletBinding()]
param(
  # Jahre
  [string[]]$Years = @('2016','2017','2018','2019','2020','2021','2022','2023','2024'),

  # Limit pro Jahr (Google MyMaps Importlimit ~2000)
  [int]$Limit = 1999,

  # Ausgabeordner
  [string]$OutDir = "out",

  # Region-Filter (Default: Region Hannover)
  [string]$ULAND = "03",
  [string]$UREGBEZ = "2",
  [string]$UKREIS = "41",
  [string]$UGEMEINDE = "",

  # Beteiligung (leer => nicht filtern)
  [string]$Rad  = "1",
  [string]$PKW  = "",
  [string]$Fuss = "",
  [string]$Krad = "",

  # City Cache / City Auswahl (optional)
  [switch]$UpdateCityCache,
  [switch]$ListCities,
  [string]$Search = "",
  [string]$City = "",

  # Mindest-Einwohner für Cache
  [int]$CityMinPop = 100000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# URLs
$BaseUrl = "https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas"
$GvzApi  = "https://gvz.tuerantuer.org/api/administrative_divisions/"

# Cache
$cacheDir = Join-Path $OutDir "cache"
$cityCache = Join-Path $OutDir "city_cache.tsv"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

function Normalize-Key([string]$s) {
  if ($null -eq $s) { return "" }
  $t = $s.ToLowerInvariant()
  $t = $t.Replace("ä","ae").Replace("ö","oe").Replace("ü","ue").Replace("ß","ss")
  $t = ($t -replace "[^a-z0-9]+","_") -replace "^_+|_+$",""
  return $t
}

function Write-CityCache {
  param([int]$MinPop)

  Write-Host "== City-Cache aktualisieren (>= $MinPop Einwohner) =="

  $rows = New-Object System.Collections.Generic.List[object]
  $page = 1

  while ($true) {
    $url = "$GvzApi?format=json&page=$page"
    $resp = Invoke-RestMethod -Uri $url -Method Get

    foreach ($r in $resp.results) {
      # division_category==60: Gemeinde
      if ($r.division_category -ne 60) { continue }
      if ($null -eq $r.citizens_total) { continue }
      if ([int]$r.citizens_total -lt $MinPop) { continue }
      if ([string]::IsNullOrWhiteSpace($r.ags)) { continue }

      $ags = ($r.ags -replace "[^\d]","")
      if ($ags.Length -eq 9) { $ags = $ags.Substring(1,8) }
      if ($ags.Length -lt 8) { $ags = $ags.PadLeft(8,'0') }
      if ($ags.Length -ne 8) { continue }

      $name = [string]$r.name
      # short name: vor Komma abschneiden
      $short = ($name -split ",")[0].Trim()

      $rows.Add([pscustomobject]@{
        Name = $short
        AGS  = $ags
        Pop  = [int]$r.citizens_total
      })
    }

    if ($null -eq $resp.next) { break }
    $page++
  }

  # Dedup by name (case-insensitive), keep max pop
  $dedup = $rows `
    | Group-Object { $_.Name.ToLowerInvariant() } `
    | ForEach-Object { $_.Group | Sort-Object Pop -Descending | Select-Object -First 1 } `
    | Sort-Object Name

  # Write TSV
  $dedup | ForEach-Object {
    "{0}`t{1}`t{2}" -f $_.Name, $_.AGS, $_.Pop
  } | Set-Content -Encoding UTF8 -Path $cityCache

  Write-Host " -> $cityCache"
}

function Require-CityCache {
  if (-not (Test-Path $cityCache)) {
    throw "City-Cache fehlt ($cityCache). Bitte erst: -UpdateCityCache"
  }
}

function List-Cities {
  Require-CityCache
  Get-Content $cityCache
}

function Search-Cities([string]$q) {
  Require-CityCache
  $nq = Normalize-Key $q
  Get-Content $cityCache | ForEach-Object {
    $parts = $_ -split "`t"
    if ($parts.Count -lt 2) { return }
    $name = $parts[0]
    $ags  = $parts[1]
    if ((Normalize-Key $name) -like "*$nq*" -or $ags -like "*$q*") {
      $_
    }
  }
}

function Set-RegionFromCity([string]$cityName) {
  Require-CityCache
  $target = $cityName.ToLowerInvariant()

  $match = Get-Content $cityCache | Where-Object {
    $parts = $_ -split "`t"
    $parts.Count -ge 2 -and $parts[0].ToLowerInvariant() -eq $target
  } | Select-Object -First 1

  if (-not $match) {
    throw "Stadt '$cityName' nicht im Cache gefunden. Nutze -Search oder aktualisiere den Cache."
  }

  $p = $match -split "`t"
  $ags = $p[1]
  $pop = if ($p.Count -ge 3) { $p[2] } else { "" }

  $script:ULAND = $ags.Substring(0,2)
  $script:UREGBEZ = $ags.Substring(2,1)
  $script:UKREIS = $ags.Substring(3,2)
  $script:UGEMEINDE = $ags.Substring(5,3)

  Write-Host "== City: $cityName (AGS $ags, Pop $pop) =="
  Write-Host "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
}

function Json-Escape([string]$s) {
  if ($null -eq $s) { return "" }
  return ($s -replace "\\","\\\\" -replace '"','\"' -replace "`r","" -replace "`n","\n")
}

function Find-ZipDataFile([string]$zipPath, [string]$year) {
  # List entries
  $entries = & unzip -Z1 $zipPath 2>$null
  if (-not $entries) { return $null }

  $pattern = [regex]::new("Unfallorte$year.*(LinRef|EPSG25832_CSV).*\.(csv|txt)$", "IgnoreCase")
  foreach ($e in $entries) {
    if ($pattern.IsMatch($e)) { return $e }
  }
  return $null
}

function Process-Year([string]$year) {
  Write-Host "== $year =="

  $zip = Join-Path $cacheDir "unfall_$year.zip"
  $url = "$BaseUrl/Unfallorte$year" + "_EPSG25832_CSV.zip"

  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing | Out-Null

  $dataFile = Find-ZipDataFile -zipPath $zip -year $year
  if (-not $dataFile) {
    Write-Warning "Keine passende Datendatei im Zip gefunden: $zip"
    return
  }

  $outCsv = Join-Path $OutDir "output$year.csv"
  $outGeo = Join-Path $OutDir "output$year.geojson"

  # Stream aus ZIP (unzip -p) -> in PowerShell als StreamReader
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "unzip"
  $psi.Arguments = "-p `"$zip`" `"$dataFile`""
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $null = $proc.Start()
  $reader = $proc.StandardOutput

  $csvWriter = New-Object System.IO.StreamWriter($outCsv, $false, (New-Object System.Text.UTF8Encoding($false)))
  $geoWriter = New-Object System.IO.StreamWriter($outGeo, $false, (New-Object System.Text.UTF8Encoding($false)))

  # CSV Header (erweitert)
  $csvWriter.WriteLine("WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH")

  # GeoJSON start
  $geoWriter.WriteLine("{")
  $geoWriter.WriteLine("  ""type"": ""FeatureCollection"",")
  $geoWriter.WriteLine("  ""features"": [")

  # Read header
  $headerLine = $reader.ReadLine()
  if ($null -eq $headerLine) {
    $csvWriter.Close(); $geoWriter.Close()
    $proc.WaitForExit()
    return
  }
  $headers = $headerLine.TrimEnd("`r") -split ";"

  # Build index lookup
  $idx = @{}
  for ($i=0; $i -lt $headers.Count; $i++) {
    $idx[$headers[$i].Trim()] = $i
  }

  function PickIndex([string[]]$names) {
    foreach ($n in $names) {
      if ($idx.ContainsKey($n)) { return [int]$idx[$n] }
    }
    return -1
  }

  $i_id     = PickIndex @("ID","OBJECTID","OBJECTID_1")
  $i_uland  = PickIndex @("ULAND")
  $i_ureg   = PickIndex @("UREGBEZ")
  $i_ukreis = PickIndex @("UKREIS")
  $i_ugem   = PickIndex @("UGEMEINDE")

  $i_rad    = PickIndex @("IstRad","ISTRAD")
  $i_pkw    = PickIndex @("IstPKW","ISTPKW")
  $i_fuss   = PickIndex @("IstFuss","ISTFUSS","IstFuß","ISTFUß")
  $i_krad   = PickIndex @("IstKrad","ISTKRAD")

  $i_licht  = PickIndex @("ULICHTVERH","U_LICHTVERH")

  $i_kat    = PickIndex @("UKATEGORIE")
  $i_typ1   = PickIndex @("UTYP1")
  $i_uart   = PickIndex @("UART")
  $i_monat  = PickIndex @("UMONAT")
  $i_stunde = PickIndex @("USTUNDE")
  $i_wtag   = PickIndex @("UWOCHENTAG")
  $i_strz   = PickIndex @("STRZUSTAND")

  # WGS84 coords
  $i_lon    = PickIndex @("XGCSWGS84","X_GCSWGS84")
  $i_lat    = PickIndex @("YGCSWGS84","Y_GCSWGS84")

  # street name (optional)
  $i_str    = PickIndex @("Strasse","STRASSE","StrName","STRNAME","USTRNAME")

  if ($i_lon -lt 0 -or $i_lat -lt 0) {
    Write-Warning "Jahr $year: keine WGS84-Spalten (XGCSWGS84/YGCSWGS84). Überspringe Ausgabe."
    $csvWriter.Close(); $geoWriter.Close()
    $proc.WaitForExit()
    return
  }

  $count = 0
  $firstFeature = $true

  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.TrimEnd("`r")
    if ($line.Length -eq 0) { continue }

    $cols = $line -split ";", -1

    # region filter
    if ($i_uland -ge 0 -and $cols[$i_uland] -ne $ULAND) { continue }
    if ($i_ureg  -ge 0 -and $cols[$i_ureg]  -ne $UREGBEZ) { continue }
    if ($i_ukreis -ge 0 -and $cols[$i_ukreis] -ne $UKREIS) { continue }
    if ($UGEMEINDE -ne "" -and $i_ugem -ge 0 -and $cols[$i_ugem] -ne $UGEMEINDE) { continue }

    # involvement filter (if any set)
    $want = $false
    $anyFilter = ($Rad -ne "" -or $PKW -ne "" -or $Fuss -ne "" -or $Krad -ne "")
    if (-not $anyFilter) {
      $want = $true
    } else {
      if ($Rad  -ne "" -and $i_rad  -ge 0 -and $cols[$i_rad]  -eq $Rad)  { $want = $true }
      if ($PKW  -ne "" -and $i_pkw  -ge 0 -and $cols[$i_pkw]  -eq $PKW)  { $want = $true }
      if ($Fuss -ne "" -and $i_fuss -ge 0 -and $cols[$i_fuss] -eq $Fuss) { $want = $true }
      if ($Krad -ne "" -and $i_krad -ge 0 -and $cols[$i_krad] -eq $Krad) { $want = $true }
    }
    if (-not $want) { continue }

    $count++
    if ($count -gt $Limit) { break }

    $id = if ($i_id -ge 0) { $cols[$i_id] } else { "$count" }

    $lon = ($cols[$i_lon] -replace ",",".")
    $lat = ($cols[$i_lat] -replace ",",".")

    $licht = if ($i_licht -ge 0) { $cols[$i_licht] } else { "" }
    $str   = if ($i_str   -ge 0) { $cols[$i_str] }   else { "" }

    $kat    = if ($i_kat    -ge 0) { $cols[$i_kat] }    else { "" }
    $typ1   = if ($i_typ1   -ge 0) { $cols[$i_typ1] }   else { "" }
    $uart   = if ($i_uart   -ge 0) { $cols[$i_uart] }   else { "" }
    $monat  = if ($i_monat  -ge 0) { $cols[$i_monat] }  else { "" }
    $stunde = if ($i_stunde -ge 0) { $cols[$i_stunde] } else { "" }
    $wtag   = if ($i_wtag   -ge 0) { $cols[$i_wtag] }   else { "" }
    $strz   = if ($i_strz   -ge 0) { $cols[$i_strz] }   else { "" }

    $name = "Unfall $id ($year)"
    if ($kat   -ne "") { $name += " Kat:$kat" }
    if ($licht -ne "") { $name += ", Licht: $licht" }
    if ($str   -ne "") { $name += " Strasse: $str" }

    # CSV row
    $wkt = "`"POINT ($lon $lat)`""
    $csvWriter.WriteLine(("{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10}" -f
      $wkt,
      $name.Replace(","," "), # CSV-safe-ish
      $id, $kat, $typ1, $uart, $monat, $stunde, $wtag, $strz, $licht
    ))

    # GeoJSON feature
    if (-not $firstFeature) { $geoWriter.WriteLine(",") }
    $firstFeature = $false

    $geoWriter.WriteLine("    {")
    $geoWriter.WriteLine("      ""type"": ""Feature"",")
    $geoWriter.WriteLine(("      ""geometry"": {{ ""type"": ""Point"", ""coordinates"": [{0}, {1}] }}," -f $lon, $lat))
    $geoWriter.WriteLine("      ""properties"": {")
    $geoWriter.WriteLine(("        ""id"": ""{0}""," -f (Json-Escape $id)))
    $geoWriter.WriteLine(("        ""name"": ""{0}""," -f (Json-Escape $name)))
    $geoWriter.WriteLine(("        ""year"": {0}," -f $year))
    $geoWriter.WriteLine(("        ""ulichtverh"": ""{0}""," -f (Json-Escape $licht)))
    $geoWriter.WriteLine(("        ""strasse"": ""{0}""," -f (Json-Escape $str)))
    $geoWriter.WriteLine(("        ""ukategorie"": ""{0}""," -f (Json-Escape $kat)))
    $geoWriter.WriteLine(("        ""utyp1"": ""{0}""," -f (Json-Escape $typ1)))
    $geoWriter.WriteLine(("        ""uart"": ""{0}""," -f (Json-Escape $uart)))
    $geoWriter.WriteLine(("        ""umonat"": ""{0}""," -f (Json-Escape $monat)))
    $geoWriter.WriteLine(("        ""ustunde"": ""{0}""," -f (Json-Escape $stunde)))
    $geoWriter.WriteLine(("        ""uwochentag"": ""{0}""," -f (Json-Escape $wtag)))
    $geoWriter.WriteLine(("        ""strzustand"": ""{0}""" -f (Json-Escape $strz)))
    $geoWriter.WriteLine("      }")
    $geoWriter.WriteLine("    }")
  }

  # GeoJSON end
  $geoWriter.WriteLine()
  $geoWriter.WriteLine("  ]")
  $geoWriter.WriteLine("}")

  $csvWriter.Close()
  $geoWriter.Close()
  $proc.WaitForExit()

  Write-Host " -> $outCsv"
  Write-Host " -> $outGeo"
}

function Combine-Csv {
  $combined = Join-Path $OutDir "output_all_years.csv"
  $header = "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH"

  $sw = New-Object System.IO.StreamWriter($combined, $false, (New-Object System.Text.UTF8Encoding($false)))
  $sw.WriteLine($header)

  foreach ($y in $Years) {
    $f = Join-Path $OutDir "output$y.csv"
    if (-not (Test-Path $f)) { continue }
    Get-Content $f | Select-Object -Skip 1 | ForEach-Object { $sw.WriteLine($_) }
  }

  $sw.Close()
  Write-Host "Combined CSV: $combined"
}

function Combine-GeoJson {
  $combined = Join-Path $OutDir "output_all_years.geojson"

  $sw = New-Object System.IO.StreamWriter($combined, $false, (New-Object System.Text.UTF8Encoding($false)))
  $sw.WriteLine("{")
  $sw.WriteLine('  "type": "FeatureCollection",')
  $sw.WriteLine('  "features": [')

  $needComma = $false

  foreach ($y in $Years) {
    $f = Join-Path $OutDir "output$y.geojson"
    if (-not (Test-Path $f)) { continue }

    # Extract lines between "features": [ and closing ]
    $lines = Get-Content $f
    $inFeatures = $false
    foreach ($ln in $lines) {
      if ($ln -match '"features"\s*:\s*\[') { $inFeatures = $true; continue }
      if ($inFeatures -and $ln -match '^\s*\]') { $inFeatures = $false; continue }
      if (-not $inFeatures) { continue }

      $trim = $ln.Trim()
      if ($trim -eq "" ) { continue }

      # Skip the opening/closing braces that are not features? (we keep feature objects and commas)
      # To avoid leading commas across files, insert a comma once when needed.
      if ($needComma -and $trim -match '^\{') {
        $sw.WriteLine(",")
        $needComma = $false
      }

      $sw.WriteLine($ln)
      if ($trim -match '^\}') {
        # next feature will come with comma already inside file, but across files we manage with $needComma flag.
        $needComma = $true
      }
    }
  }

  $sw.WriteLine()
  $sw.WriteLine("  ]")
  $sw.WriteLine("}")
  $sw.Close()

  Write-Host "Combined GEO: $combined"
}

# --- City/Cache Commands (optional) ---
if ($UpdateCityCache) {
  Write-CityCache -MinPop $CityMinPop
}

if ($ListCities) {
  List-Cities
  exit 0
}

if ($Search -ne "") {
  Search-Cities -q $Search
  exit 0
}

if ($City -ne "") {
  Set-RegionFromCity -cityName $City
}

# --- Main processing ---
foreach ($y in $Years) {
  try {
    Process-Year -year $y
  } catch {
    Write-Warning "Jahr $y: $($_.Exception.Message)"
  }
}

Combine-Csv
Combine-GeoJson

Write-Host "== fertig =="
Write-Host "Filter: ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS$(if($UGEMEINDE){' UGEMEINDE='+$UGEMEINDE}else{''})"
Write-Host "OutDir: $OutDir"
Write-Host "CityCache: $cityCache"