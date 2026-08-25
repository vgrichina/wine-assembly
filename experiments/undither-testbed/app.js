(function startTestbed() {
  'use strict';

  const algorithms = window.UnditherAlgorithms;
  const corpus = window.UNDITHER_SAMPLES;
  const byId = id => document.getElementById(id);
  const ui = {
    sample: byId('sample'),
    region: byId('region'),
    file: byId('file'),
    algorithm: byId('algorithm'),
    algorithmDescription: byId('algorithm-description'),
    radius: byId('radius'),
    radiusValue: byId('radius-value'),
    strength: byId('strength'),
    strengthValue: byId('strength-value'),
    threshold: byId('threshold'),
    thresholdValue: byId('threshold-value'),
    iterations: byId('iterations'),
    iterationsValue: byId('iterations-value'),
    matrixSize: byId('matrix-size'),
    zoom: byId('zoom'),
    zoomValue: byId('zoom-value'),
    syncScroll: byId('sync-scroll'),
    expectation: byId('expectation'),
    provenance: byId('provenance'),
    status: byId('status'),
    stats: byId('stats'),
    palette: byId('palette'),
    download: byId('download'),
    originalFull: byId('original-full'),
    outputFull: byId('output-full'),
    differenceFull: byId('difference-full'),
    referenceFull: byId('reference-full'),
    originalView: byId('original-view'),
    outputView: byId('output-view'),
    differenceView: byId('difference-view'),
    referenceView: byId('reference-view'),
    referenceFigure: byId('reference-figure'),
    originalViewport: byId('original-viewport'),
    outputViewport: byId('output-viewport'),
  };

  const state = {
    sample: null,
    input: null,
    output: null,
    reference: null,
    palette: null,
    timer: null,
    generation: 0,
    syncingScroll: false,
    wineAssemblyCanvas: null,
    wineAssemblyFilter: null,
  };

  function setStatus(text, busy) {
    ui.status.textContent = text;
    ui.status.classList.toggle('busy', !!busy);
  }

  function populateSelectors() {
    for (const sample of corpus) {
      const option = document.createElement('option');
      option.value = sample.id;
      option.textContent = sample.label;
      ui.sample.append(option);
    }
    for (const [id, info] of Object.entries(algorithms.algorithmInfo)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = info.label;
      ui.algorithm.append(option);
    }
    ui.algorithm.value = 'adaptiveFir';
  }

  function currentOptions() {
    return {
      radius: Number(ui.radius.value),
      strength: Number(ui.strength.value) / 100,
      threshold: Number(ui.threshold.value),
      iterations: Number(ui.iterations.value),
      matrixSize: Number(ui.matrixSize.value),
    };
  }

  function updateControlLabels() {
    ui.radiusValue.textContent = `${ui.radius.value}px`;
    ui.strengthValue.textContent = `${ui.strength.value}%`;
    ui.thresholdValue.textContent = ui.threshold.value;
    ui.iterationsValue.textContent = ui.iterations.value;
    ui.zoomValue.textContent = `${ui.zoom.value}×`;
    const name = ui.algorithm.value;
    const fixedWineAssembly = name === 'waMdapt' || name === 'waJinc2';
    const fixedPriorArt = name === 'kornelski' || name === 'sgenpt';
    ui.algorithmDescription.textContent = algorithms.algorithmInfo[name].description;
    ui.radius.disabled = fixedWineAssembly || fixedPriorArt || name === 'original' || name === 'anisotropic' || name === 'orderedCell';
    ui.strength.disabled = fixedWineAssembly || name === 'original';
    ui.threshold.disabled = fixedWineAssembly || fixedPriorArt || name === 'original' || name === 'box' || name === 'gaussian';
    ui.iterations.disabled = name !== 'anisotropic';
    ui.matrixSize.disabled = name !== 'orderedCell';
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load ${src}`));
      image.src = src;
    });
  }

  function imageFromCanvas(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: pixels.data };
  }

  function putImage(canvas, image) {
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }

  function updateRegions(sample) {
    ui.region.replaceChildren();
    for (let index = 0; index < sample.regions.length; index++) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = sample.regions[index].label;
      ui.region.append(option);
    }
    ui.region.value = sample.regions.length > 1 ? '1' : '0';
    ui.zoom.value = String(sample.regions[Number(ui.region.value)].zoom || 2);
  }

  function showPalette() {
    ui.palette.replaceChildren();
    if (!state.palette) return;
    const ordered = state.palette.colors.map((color, id) => ({ color, count: state.palette.counts[id] }))
      .sort((a, b) => b.count - a.count);
    for (const entry of ordered.slice(0, 256)) {
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.backgroundColor = `rgb(${entry.color.join(',')})`;
      swatch.title = `rgb(${entry.color.join(', ')}) — ${entry.count.toLocaleString()} pixels`;
      ui.palette.append(swatch);
    }
  }

  async function selectSample(sample) {
    state.generation++;
    setStatus(`Loading ${sample.label}…`, true);
    try {
      const [image, referenceImage] = await Promise.all([
        loadImage(sample.src),
        sample.referenceSrc ? loadImage(sample.referenceSrc) : Promise.resolve(null),
      ]);
      state.sample = sample;
      ui.originalFull.width = image.naturalWidth;
      ui.originalFull.height = image.naturalHeight;
      const context = ui.originalFull.getContext('2d', { willReadFrequently: true });
      context.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
      context.drawImage(image, 0, 0);
      state.input = imageFromCanvas(ui.originalFull);
      state.reference = null;
      if (referenceImage) {
        ui.referenceFull.width = referenceImage.naturalWidth;
        ui.referenceFull.height = referenceImage.naturalHeight;
        ui.referenceFull.getContext('2d', { willReadFrequently: true }).drawImage(referenceImage, 0, 0);
        state.reference = imageFromCanvas(ui.referenceFull);
        if (state.reference.width !== state.input.width || state.reference.height !== state.input.height) {
          throw new Error('Author reference dimensions do not match its dithered input');
        }
      }
      ui.referenceFigure.hidden = !state.reference;
      state.palette = algorithms.extractPalette(state.input);
      ui.expectation.textContent = sample.expectation;
      ui.provenance.textContent = `Source: ${sample.provenance}`;
      updateRegions(sample);
      showPalette();
      updateControlLabels();
      scheduleProcessing(0);
    } catch (error) {
      setStatus(error.message, false);
    }
  }

  function selectLocalFile(file) {
    const url = URL.createObjectURL(file);
    const sample = {
      id: 'local',
      label: file.name,
      src: url,
      provenance: file.name,
      expectation: 'Unannotated local image. Treat every apparent improvement as a hypothesis until checked against source intent.',
      regions: [{ label: 'Full frame', x: 0, y: 0, w: 1, h: 1, zoom: 1 }],
    };
    loadImage(url).then(image => {
      sample.regions[0].w = image.naturalWidth;
      sample.regions[0].h = image.naturalHeight;
      return selectSample(sample);
    }).finally(() => URL.revokeObjectURL(url));
  }

  function scheduleProcessing(delay) {
    if (!state.input) return;
    clearTimeout(state.timer);
    const generation = ++state.generation;
    setStatus(`Queued ${algorithms.algorithmInfo[ui.algorithm.value].label}…`, true);
    state.timer = setTimeout(() => processImage(generation), delay == null ? 90 : delay);
  }

  function processImage(generation) {
    const algorithm = ui.algorithm.value;
    const started = performance.now();
    setStatus(`Running ${algorithms.algorithmInfo[algorithm].label} at ${state.input.width}×${state.input.height}…`, true);
    setTimeout(() => {
      try {
        const output = runAlgorithm(algorithm);
        if (generation !== state.generation) return;
        const elapsed = performance.now() - started;
        state.output = output;
        putImage(ui.outputFull, output);
        const measurements = makeDifference(state.input, output);
        putImage(ui.differenceFull, measurements.image);
        showStats(measurements, elapsed);
        renderViews();
        setStatus(`${algorithms.algorithmInfo[algorithm].label} completed in ${elapsed.toFixed(1)} ms.`, false);
      } catch (error) {
        setStatus(error.stack || error.message, false);
      }
    }, 0);
  }

  function runAlgorithm(algorithm) {
    if (algorithm !== 'waMdapt' && algorithm !== 'waJinc2') {
      return algorithms.run(algorithm, state.input, currentOptions());
    }
    if (!window.presentationFilter || !window.presentationFilter.PresentationFilter) {
      throw new Error('WineAssembly presentation-filter.js did not load');
    }
    if (!state.wineAssemblyCanvas) {
      state.wineAssemblyCanvas = document.createElement('canvas');
      state.wineAssemblyFilter = new window.presentationFilter.PresentationFilter(state.wineAssemblyCanvas);
    }
    state.wineAssemblyCanvas.width = state.input.width;
    state.wineAssemblyCanvas.height = state.input.height;
    const mode = algorithm === 'waMdapt' ? 'mdapt' : 'jinc2';
    const rendered = state.wineAssemblyFilter.present(ui.originalFull, 'nearest', {}, { dedither: mode });
    if (!rendered || state.wineAssemblyFilter.lastDeditherBackend !== `webgl-${mode}`) {
      const detail = state.wineAssemblyFilter.lastError ? `: ${state.wineAssemblyFilter.lastError.message}` : '';
      throw new Error(`WineAssembly ${mode} shader unavailable${detail}`);
    }
    return imageFromCanvas(state.wineAssemblyCanvas);
  }

  function makeDifference(input, output) {
    const data = new Uint8ClampedArray(input.data.length);
    let changed = 0;
    let sum = 0;
    let maximum = 0;
    for (let p = 0; p < input.width * input.height; p++) {
      const i = p * 4;
      let pixelChanged = false;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(input.data[i + channel] - output.data[i + channel]);
        data[i + channel] = Math.min(255, delta * 4);
        sum += delta;
        maximum = Math.max(maximum, delta);
        if (delta) pixelChanged = true;
      }
      data[i + 3] = 255;
      if (pixelChanged) changed++;
    }
    return {
      image: { width: input.width, height: input.height, data },
      changed,
      mean: sum / (input.width * input.height * 3),
      maximum,
    };
  }

  function showStats(measurements, elapsed) {
    const pixels = state.input.width * state.input.height;
    const rows = [
      ['Native frame', `${state.input.width} × ${state.input.height}`],
      ['Displayed colors used', state.palette.colors.length.toLocaleString()],
      ['Changed pixels', `${measurements.changed.toLocaleString()} (${(measurements.changed * 100 / pixels).toFixed(2)}%)`],
      ['Mean |Δ| / channel', measurements.mean.toFixed(3)],
      ['Maximum channel Δ', String(measurements.maximum)],
      ['Processing time', `${elapsed.toFixed(1)} ms`],
    ];
    if (state.reference) {
      const inputReference = measureDistance(state.input, state.reference);
      const outputReference = measureDistance(state.output, state.reference);
      rows.splice(5, 0,
        ['Input |Δ| vs author', inputReference.mean.toFixed(3)],
        ['Output |Δ| vs author', outputReference.mean.toFixed(3)]);
    }
    ui.stats.replaceChildren();
    for (const [term, value] of rows) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      ui.stats.append(dt, dd);
    }
  }

  function measureDistance(first, second) {
    let sum = 0;
    let maximum = 0;
    for (let i = 0; i < first.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(first.data[i + channel] - second.data[i + channel]);
        sum += delta;
        maximum = Math.max(maximum, delta);
      }
    }
    return { mean: sum / (first.width * first.height * 3), maximum };
  }

  function selectedRegion() {
    const fallback = { x: 0, y: 0, w: state.input.width, h: state.input.height };
    if (!state.sample) return fallback;
    const region = state.sample.regions[Number(ui.region.value)] || fallback;
    return {
      x: Math.max(0, Math.min(state.input.width - 1, region.x)),
      y: Math.max(0, Math.min(state.input.height - 1, region.y)),
      w: Math.max(1, Math.min(region.w, state.input.width - region.x)),
      h: Math.max(1, Math.min(region.h, state.input.height - region.y)),
    };
  }

  function renderCanvasCrop(source, destination, region, zoom) {
    destination.width = region.w * zoom;
    destination.height = region.h * zoom;
    const context = destination.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, destination.width, destination.height);
    context.drawImage(source, region.x, region.y, region.w, region.h,
      0, 0, destination.width, destination.height);
  }

  function renderViews() {
    if (!state.input || !state.output) return;
    const region = selectedRegion();
    const zoom = Number(ui.zoom.value);
    renderCanvasCrop(ui.originalFull, ui.originalView, region, zoom);
    renderCanvasCrop(ui.outputFull, ui.outputView, region, zoom);
    renderCanvasCrop(ui.differenceFull, ui.differenceView, region, zoom);
    if (state.reference) renderCanvasCrop(ui.referenceFull, ui.referenceView, region, zoom);
    updateControlLabels();
  }

  function syncScroll(source, target) {
    if (!ui.syncScroll.checked || state.syncingScroll) return;
    state.syncingScroll = true;
    target.scrollLeft = source.scrollLeft;
    target.scrollTop = source.scrollTop;
    requestAnimationFrame(() => { state.syncingScroll = false; });
  }

  function bindEvents() {
    ui.sample.addEventListener('change', () => {
      const sample = corpus.find(entry => entry.id === ui.sample.value);
      if (sample) selectSample(sample);
    });
    ui.file.addEventListener('change', () => {
      if (ui.file.files[0]) selectLocalFile(ui.file.files[0]);
    });
    ui.region.addEventListener('change', () => {
      const region = state.sample.regions[Number(ui.region.value)];
      if (region && region.zoom) ui.zoom.value = String(region.zoom);
      renderViews();
    });
    ui.zoom.addEventListener('input', renderViews);
    for (const control of [ui.algorithm, ui.radius, ui.strength, ui.threshold, ui.iterations, ui.matrixSize]) {
      control.addEventListener('input', () => {
        updateControlLabels();
        scheduleProcessing();
      });
    }
    ui.originalViewport.addEventListener('scroll', () => syncScroll(ui.originalViewport, ui.outputViewport));
    ui.outputViewport.addEventListener('scroll', () => syncScroll(ui.outputViewport, ui.originalViewport));
    ui.download.addEventListener('click', () => {
      if (!state.output) return;
      const link = document.createElement('a');
      link.download = `${state.sample.id}-${ui.algorithm.value}.png`;
      link.href = ui.outputFull.toDataURL('image/png');
      link.click();
    });
  }

  populateSelectors();
  bindEvents();
  updateControlLabels();
  selectSample(corpus[0]);
}());
