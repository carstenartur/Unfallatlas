(() => {
  'use strict';

  const UA = window.UA = window.UA || {};
  const states = new WeakMap();
  const title = 'Radzählstelle Mannesmannufer';
  const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text || '' });
  const inCity = ctx => /^(düsseldorf|duesseldorf)$/i.test(String(ctx.CITY_RAW || '').trim());

  function link(label, href) {
    const url = new URL(href);
    if (url.protocol !== 'https:') throw new Error('Ungültiger Quellenlink');
    return Object.assign(element('a', label), { href: url.href, target: '_blank', rel: 'noopener noreferrer' });
  }

  function stationPopup(data) {
    const popup = element('div');
    const date = Object.assign(element('input'), { type: 'date', min: '2024-01-01', max: '2024-12-31', value: '2024-01-01' });
    const hour = element('select');
    for (let h = 0; h < 24; h++) {
      const value = String(h).padStart(2, '0');
      hour.append(new Option(value + ':00', value));
    }
    const dateLabel = element('label', 'Datum ');
    const hourLabel = element('label', ' Stunde ');
    dateLabel.append(date);
    hourLabel.append(hour);
    const readings = element('output');
    function update() {
      const [year, month, day] = date.value.split('-');
      const pair = data.hours[day + '-' + month + '-' + year + ' ' + hour.value + ':00:00'];
      readings.replaceChildren();
      if (!pair) {
        readings.textContent = 'Für diese Quellstunde ist kein Stundenwert vorhanden.';
        return;
      }
      for (const [index, channel] of data.directions.entries()) {
        const value = pair[index];
        const result = Number.isSafeInteger(value) && value >= 0
          ? value.toLocaleString('de-DE') + (value === 1 ? ' Fahrrad/Stunde' : ' Fahrräder/Stunde')
          : 'kein Stundenwert';
        readings.append(element('div', channel.direction + ' · ' + result));
      }
    }
    date.addEventListener('change', update);
    hour.addEventListener('change', update);
    update();
    const sources = element('details');
    sources.append(element('summary', 'Quellen und Lizenzen'));
    for (const [key, name] of [['counts', 'Stundenwerte'], ['station', 'Standort'], ['osm', 'Radweg']]) {
      const source = data.sources[key];
      const line = element('div');
      line.append(link(name, key === 'osm' ? source.distributionUrl : source.datasetUrl), ' · ' + (source.requiredAttribution || source.publisher) + ' · ',
        link(source.licenseId, source.licenseUrl));
      sources.append(line);
    }
    popup.append(element('strong', title + ' · 2024'), element('p', 'Amtliche Quellstunde wählen. Zeitzone und Intervallgrenzen sind unbekannt.'),
      dateLabel, hourLabel, readings, element('p', 'Richtungszählung am Radweg auf Höhe der Thomasstraße.'), sources);
    return popup;
  }

  function createControl(ctx) {
    const map = ctx.map;
    const root = element('div');
    const label = element('label');
    const toggle = Object.assign(element('input'), { type: 'checkbox', name: 'bikeCounts' });
    const locate = Object.assign(element('button', 'Zählstelle anzeigen'), { type: 'button', className: 'mapSettingButton', hidden: true });
    const status = element('div');
    status.className = 'mobility-layer-status';
    status.setAttribute('role', 'status');
    label.append(toggle, ' Radzählstelle Mannesmannufer (2024)');
    root.append(label, locate, status);
    let marker, request, error = false;

    function refresh() {
      const active = ctx.contextOverlays.active.bikeCounts === true;
      toggle.checked = active;
      locate.hidden = !active || !marker;
      if (!active) {
        marker?.remove();
        error = false;
        status.textContent = '';
      } else if (marker) {
        if (!map.hasLayer(marker)) marker.addTo(map);
        status.textContent = '';
      } else if (error) {
        status.textContent = 'Die Radzählung konnte nicht geladen werden. Zum erneuten Laden aus- und einschalten.';
      } else if (!request) {
        status.textContent = 'Stundenwerte werden geladen …';
        request = UA.DataResources.fetchJson('duesseldorfBikeCounts').then(data => {
          const [lon, lat] = data.station.geometry.coordinates;
          marker = window.L.marker([lat, lon], { title, alt: title,
            attribution: 'Radzählung: Landeshauptstadt Düsseldorf (DL-DE-BY-2.0)' }).bindPopup(stationPopup(data));
        }).catch(() => { error = true; }).finally(() => {
          request = null;
          if (states.get(ctx)?.root === root && inCity(ctx)) refresh();
        });
      }
    }
    toggle.addEventListener('change', () => {
      if (states.get(ctx)?.root !== root || !inCity(ctx)) return;
      ctx.contextOverlays.active.bikeCounts = toggle.checked;
      refresh();
      UA.syncAllToUrl?.(ctx);
    });
    locate.addEventListener('click', () => {
      if (!marker || !map.hasLayer(marker)) return;
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
      marker.openPopup();
    });
    function dispose() {
      map.off('unload', dispose);
      marker?.remove();
      root.remove();
      states.delete(ctx);
    }
    map.once('unload', dispose);
    return { root, map, refresh, dispose };
  }

  UA.DuesseldorfBikeCounts = {
    controlContent(ctx) {
      let state = states.get(ctx);
      const available = inCity(ctx) && ctx.map && window.L;
      if (state && (!available || state.map !== ctx.map)) {
        state.dispose();
        state = null;
      }
      if (!available) return null;
      if (!state) {
        ctx.contextOverlays ||= {};
        ctx.contextOverlays.active ||= {};
        state = createControl(ctx);
        states.set(ctx, state);
      }
      state.refresh();
      return state.root;
    },
  };
})();
