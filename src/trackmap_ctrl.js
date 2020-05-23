import L from './leaflet/leaflet.js';
import moment from 'moment';

import leafletPolycolor from './leaflet-polycolor.js';

import appEvents from 'app/core/app_events';
import {MetricsPanelCtrl} from 'app/plugins/sdk';

import './leaflet/leaflet.css!';
import './partials/module.css!';

const panelDefaults = {
  maxDataPoints: 500,
  autoZoom: true,
  scrollWheelZoom: false,
  defaultLayer: 'OpenStreetMap',
  lineColor: '#f2495d',
  pointColor: 'royalblue',
  gradientStartColor: '#f2495d',
  gradientEndColor: '#73bf69'
}

function log(msg) {
  // uncomment for debugging
  console.log(msg);
}
function hexToRgbString(hex) {
  const rgb = hexToRgb(hex);
  return 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
}
function hexToRgb(hex) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}
export class TrackMapCtrl extends MetricsPanelCtrl {
  constructor($scope, $injector) {
    super($scope, $injector);

    log("constructor");

    _.defaults(this.panel, panelDefaults);
    leafletPolycolor(L);

    // Save layers globally in order to use them in options
    this.layers = {
      'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
      }),
      'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data: &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        maxZoom: 17
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imagery &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        // This map doesn't have labels so we force a label-only layer on top of it
        forcedOverlay: L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png', {
          attribution: 'Labels by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          subdomains: 'abcd',
          maxZoom: 20,
        })
      })
    };

    this.timeSrv = $injector.get('timeSrv');
    this.coords = [];
    this.leafMap = null;
    this.polyline = null;
    this.hoverMarker = null;
    this.hoverTarget = null;
    this.setSizePromise = null;

    // Panel events
    this.events.on('panel-initialized', this.onInitialized.bind(this));
    this.events.on('view-mode-changed', this.onViewModeChanged.bind(this));
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('panel-teardown', this.onPanelTeardown.bind(this));
    this.events.on('panel-size-changed', this.onPanelSizeChanged.bind(this));
    this.events.on('data-received', this.onDataReceived.bind(this));
    this.events.on('data-snapshot-load', this.onDataSnapshotLoad.bind(this));

    // Global events
    appEvents.on('graph-hover', this.onPanelHover.bind(this));
    appEvents.on('graph-hover-clear', this.onPanelClear.bind(this));
  }

  onInitialized(){
    log("onInitialized");
    this.render();
  }

  onInitEditMode() {
    log("onInitEditMode");
    this.addEditorTab('Options', 'public/plugins/pr0ps-trackmap-panel/partials/options.html', 2);
  }

  onPanelTeardown() {
    log("onPanelTeardown");
    this.$timeout.cancel(this.setSizePromise);
  }

  onPanelHover(evt) {
    log("onPanelHover");
    if (this.coords.length === 0) {
      return;
    }

    // check if we are already showing the correct hoverMarker
    let target = Math.floor(evt.pos.x);
    if (this.hoverTarget && this.hoverTarget === target) {
      return;
    }

    // check for initial show of the marker
    if (this.hoverTarget == null){
      this.hoverMarker.addTo(this.leafMap);
    }

    this.hoverTarget = target;

    // Find the currently selected time and move the hoverMarker to it
    // Note that an exact match isn't always going to work due to rounding so
    // we clean that up later (still more efficient)
    let min = 0;
    let max = this.coords.length - 1;
    let idx = null;
    let exact = false;
    while (min <= max) {
      idx = Math.floor((max + min) / 2);
      if (this.coords[idx].timestamp === this.hoverTarget) {
        exact = true;
        break;
      }
      else if (this.coords[idx].timestamp < this.hoverTarget) {
        min = idx + 1;
      }
      else {
        max = idx - 1;
      }
    }

    // Correct the case where we are +1 index off
    if (!exact && idx > 0 && this.coords[idx].timestamp > this.hoverTarget) {
      idx--;
    }
    this.hoverMarker.setLatLng(this.coords[idx].position);
  }

  onPanelClear(evt) {
    log("onPanelClear");
    // clear the highlighted circle
    this.hoverTarget = null;
    if (this.hoverMarker) {
      this.hoverMarker.removeFrom(this.leafMap);
    }
  }

  onViewModeChanged(){
    log("onViewModeChanged");
    // KLUDGE: When the view mode is changed, panel resize events are not
    //         emitted even if the panel was resized. Work around this by telling
    //         the panel it's been resized whenever the view mode changes.
    this.onPanelSizeChanged();
  }

  onPanelSizeChanged() {
    log("onPanelSizeChanged");
    // KLUDGE: This event is fired too soon - we need to delay doing the actual
    //         size invalidation until after the panel has actually been resized.
    this.$timeout.cancel(this.setSizePromise);
    let map = this.leafMap;
    this.setSizePromise = this.$timeout(function(){
      if (map) {
        log("Invalidating map size");
        map.invalidateSize(true);
      }}, 500
    );
  }

  applyScrollZoom() {
    let enabled = this.leafMap.scrollWheelZoom.enabled();
    if (enabled != this.panel.scrollWheelZoom){
      if (enabled){
        this.leafMap.scrollWheelZoom.disable();
      }
      else{
        this.leafMap.scrollWheelZoom.enable();
      }
    }
  }

  applyDefaultLayer() {
    let hadMap = Boolean(this.leafMap);
    this.setupMap();
    // Only need to re-add layers if the map previously existed
    if (hadMap){
      this.leafMap.eachLayer((layer) => {
        layer.removeFrom(this.leafMap);
      });
      this.layers[this.panel.defaultLayer].addTo(this.leafMap);
    }
    this.addDataToMap();
  }

  setupMap() {
    log("setupMap");
    // Create the map or get it back in a clean state if it already exists
    if (this.leafMap) {
      if (this.polyline) {
        this.polyline.removeFrom(this.leafMap);
      }
      this.onPanelClear();
      return;
    }

    // Create the map
    this.leafMap = L.map('trackmap-' + this.panel.id, {
      scrollWheelZoom: this.panel.scrollWheelZoom,
      zoomSnap: 0.5,
      zoomDelta: 1,
    });

    // Add layers to the control widget
    L.control.layers(this.layers).addTo(this.leafMap);

    // Add default layer to map
    this.layers[this.panel.defaultLayer].addTo(this.leafMap);

    // Hover marker
    this.hoverMarker = L.circleMarker(L.latLng(0, 0), {
      color: 'white',
      fillColor: this.panel.pointColor,
      fillOpacity: 1,
      weight: 2,
      radius: 7
    });

    // Events
    this.leafMap.on('baselayerchange', this.mapBaseLayerChange.bind(this));
    this.leafMap.on('boxzoomend', this.mapZoomToBox.bind(this));
  }

  mapBaseLayerChange(e) {
    // If a tileLayer has a 'forcedOverlay' attribute, always enable/disable it
    // along with the layer
    if (this.leafMap.forcedOverlay) {
      this.leafMap.forcedOverlay.removeFrom(this.leafMap);
      this.leafMap.forcedOverlay = null;
    }
    let overlay = e.layer.options.forcedOverlay;
    if (overlay) {
      overlay.addTo(this.leafMap);
      overlay.setZIndex(e.layer.options.zIndex + 1);
      this.leafMap.forcedOverlay = overlay;
    }
  }

  mapZoomToBox(e) {
    log("mapZoomToBox");
    // Find time bounds of selected coordinates
    const bounds = this.coords.reduce(
      function(t, c) {
        if (e.boxZoomBounds.contains(c.position)) {
          t.from = Math.min(t.from, c.timestamp);
          t.to = Math.max(t.to, c.timestamp);
        }
        return t;
      },
      {from: Infinity, to: -Infinity}
    );

    // Set the global time range
    if (isFinite(bounds.from) && isFinite(bounds.to)) {
      // KLUDGE: Create moment objects here to avoid a TypeError that
      //         occurs when Grafana processes normal numbers
      this.timeSrv.setTime({
        from: moment.utc(bounds.from),
        to: moment.utc(bounds.to)
      });
    }
  }

  // Add the circles and polyline to the map
  addDataToMap() {
    log("addDataToMap");
    const colors = this.coords.map(x => x.color);
    this.polyline = L.polycolor(
      this.coords.map(x => x.position, this), {
        colors: colors,
        weight: 3,
      }
    ).addTo(this.leafMap);

    this.zoomToFit();
  }

  zoomToFit(){
    log("zoomToFit");
    if (this.panel.autoZoom && this.polyline){
      this.leafMap.fitBounds(this.polyline.getBounds());
    }
    this.render();
  }

  refreshColors() {
    log("refreshColors");
    if (this.polyline) {
      this.setupMap();
      this.scaleData();
      this.addDataToMap();
    }
    if (this.hoverMarker){
      this.hoverMarker.setStyle({
        fillColor: this.panel.pointColor,
      });
    }
    this.render();
  }

  onDataReceived(data) {
    log("onDataReceived");
    this.setupMap();

    if (data.length < 2 || data.length > 3) {
      // No data or incorrect data, show a world map and abort
      this.leafMap.setView([0, 0], 1);
      return;
    }
    const hasScaleData = data.length == 3 ? true : false;

    // Asumption is that there are an equal number of properly matched timestamps
    // TODO: proper joining by timestamp?
    this.coords.length = 0;
    const lats = data[0].datapoints;
    const lons = data[1].datapoints;
    const scalars = data[2].datapoints;
    let lastScalar = 1;

    for (let i = 0; i < lats.length; i++) {
      let scalar = null
      // Validate lat and lng have values and timestamps match
      if (lats[i][0] == null || lons[i][0] == null ||
          lats[i][1] !== lons[i][1]) {
        continue; // Coordinate is not valid
      }
      if(hasScaleData) {
        if (lats[i][0] == null || scalars[i][0] == null ||
          lats[i][1] !== scalars[i][1]) {
            scalar = lastScalar; // Scale is not valid - Use last point scale value
        }
        else {
          scalar = scalars[i][0];
          lastScalar = scalar;
        }
      }
      else scalar = 1; // Use max scale if point is scale data not available

      this.coords.push({
        position: L.latLng(lats[i][0], lons[i][0]),
        timestamp: lats[i][1],
        scalar: scalar,
      });
    }

    this.scaleData();

    this.addDataToMap();
  }

  scaleData() {
    log("scaleData");
    const maxScalar = Math.max(...this.coords.map(x => x. scalar));
    const minScalar = Math.min(...this.coords.map(x => x.scalar));
    log("Max: " + maxScalar);
    log("Min: " + minScalar);

    const startRGB = hexToRgb(this.panel.gradientStartColor);
    const endRGB = hexToRgb(this.panel.gradientEndColor);

    for (let i = 0; i < this.coords.length; i++) {
      let currentCoord = this.coords[i];
      const normalized = (currentCoord.scalar - minScalar) / (maxScalar - minScalar);
      currentCoord.normalized = normalized;

      const r = startRGB.r + normalized * (endRGB.r - startRGB.r);
      const g = startRGB.g + normalized * (endRGB.g - startRGB.g);
      const b = startRGB.b + normalized * (endRGB.b - startRGB.b);
      currentCoord.color = 'rgb(' + r + ',' + g + ',' + b + ')';
    }
  }

  onDataSnapshotLoad(snapshotData) {
    log("onSnapshotLoad");
    this.onDataReceived(snapshotData);
  }
}

TrackMapCtrl.templateUrl = 'partials/module.html';
