const $ = (id) => document.getElementById(id);

let appState = null;
let selectedAssetId = null;
let previewOverride = null; // { type: 'video'|'image', url, title, isCutout }
let pollTimer = null;
let toastTimer = null;

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Blob)
      ? {'Content-Type': 'application/json'}
      : undefined,
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function kindLabel(kind) {
  if (kind === 'flow') return 'Flow AI';
  if (kind === 'mannequin') return '마네킨 원본';
  if (kind === 'video') return '내 동영상';
  return '공식몰';
}

function renderEnv(env) {
  const wrap = $('envPills') || document.createElement('div');
  const items = [
    {label: 'FFmpeg', ok: env.ffmpeg},
    {label: 'Chrome', ok: env.chrome},
    {label: '등록기 연동', ok: env.registrarLinked},
    {label: '사진폴더', ok: env.photoFolderLinked},
  ];
  wrap.innerHTML = items.map(it =>
    `<span class="env-chip ${it.ok ? 'ok' : ''}">${it.ok ? '●' : '○'} ${it.label}</span>`
  ).join('');
}

function renderRecentStyles(list) {
  const wrap = $('recentStylesWrap');
  const container = $('recentStyleChips');
  if (!list || !list.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  container.innerHTML = '';
  for (const item of list.slice(0, 8)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-chip';
    btn.textContent = `${item.style} · ${String(item.name || '').slice(0, 14)}`;
    btn.addEventListener('click', () => {
      $('styleInput').value = item.style;
      loadProduct();
    });
    container.appendChild(btn);
  }
}

function renderFlowModels(models, currentId) {
  const sel = $('flowModelSelect');
  if (sel.options.length !== models.length) {
    sel.innerHTML = models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  }
  sel.value = currentId;
}

let selectedPresetCategory = null;
let lastSyncedGarmentGroup = null;

function renderFlowPresets(presets, currentPresetId) {
  const wrap = $('flowPresetButtons');
  const tabsWrap = $('presetCatTabs');
  if (!wrap || !presets) return;

  const resolvedCat = appState?.flow?.resolvedCategory || 'top';
  const desiredGroup = resolvedCat === 'bottom' ? '👖 하의' : '👕 상의·아우터';
  if (!selectedPresetCategory || lastSyncedGarmentGroup !== desiredGroup) {
    selectedPresetCategory = desiredGroup;
    lastSyncedGarmentGroup = desiredGroup;
  }

  const categories = [...new Set(presets.map(p => p.category).filter(Boolean)), '전체'];
  if (tabsWrap) {
    tabsWrap.innerHTML = '';
    for (const cat of categories) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `preset-cat-btn ${cat === selectedPresetCategory ? 'active' : ''}`;
      const count = cat === '전체' ? presets.length : presets.filter(p => p.category === cat).length;
      btn.textContent = `${cat} ${count}`;
      btn.addEventListener('click', () => {
        selectedPresetCategory = cat;
        renderFlowPresets(appState.flowPresets, appState.flow.presetId);
      });
      tabsWrap.appendChild(btn);
    }
  }

  const filtered = selectedPresetCategory === '전체'
    ? presets
    : presets.filter(p => p.category === selectedPresetCategory);

  wrap.innerHTML = '';
  for (const preset of filtered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-pill-btn ${preset.id === currentPresetId ? 'active' : ''}`;
    btn.textContent = preset.label;
    btn.addEventListener('click', async () => {
      try {
        appState = await api('/api/facts/update', {
          method: 'POST',
          body: JSON.stringify({
            flow: {
              modelId: $('flowModelSelect').value,
              garmentCategory: $('flowGarmentCategorySelect')?.value || 'auto',
              durationSec: Number($('flowDurationSelect').value || 15),
              presetId: preset.id,
              customDirection: $('flowCustomDirection').value,
            },
          }),
        });
        renderFactsAndOptions();
        showToast(`연출 프리셋 적용됨: ${preset.label}`);
      } catch (err) {
        showToast(err.message);
      }
    });
    wrap.appendChild(btn);
  }
}

function renderFilmStrip(assets) {
  const wrap = $('filmStrip');
  const enabledCount = (assets || []).filter(a => a.enabled !== false).length;
  const countEl = $('assetCountLabel');
  if (countEl) countEl.textContent = `총 ${(assets || []).length}개 (사용 ${enabledCount}개)`;

  if (!assets || !assets.length) {
    wrap.innerHTML = `<div class="empty-stage-note">품번을 불러오거나 매장 마네킨 샷 · 동영상을 올려두면 이곳에 필름 컷이 차곡차곡 쌓입니다.</div>`;
    return;
  }
  wrap.innerHTML = '';
  assets.forEach((asset, idx) => {
    const card = document.createElement('div');
    card.className = `asset-card ${asset.id === selectedAssetId ? 'selected' : ''} ${asset.enabled === false ? 'disabled' : ''}`;

    const thumbHtml = asset.mediaType === 'video'
      ? `<video src="${asset.url}" muted playsinline preload="metadata"></video>`
      : `<img src="${asset.url}" alt="${asset.label}">`;

    const isHero = asset.mediaType === 'image' && appState?.flow?.heroAssetId === asset.id;

    card.innerHTML = `
      <div class="asset-thumb-box">
        ${thumbHtml}
        <span class="asset-tag ${asset.kind}">${isHero ? '★ 시작사진' : kindLabel(asset.kind)}</span>
      </div>
      <div class="asset-body">
        <div class="asset-name" title="${asset.label}">${idx + 1}. ${asset.label}</div>
        ${asset.mediaType === 'video' ? `
          <div class="trim-row">
            <label>시작(초)<input type="number" class="trim-start" min="0" step="0.5" value="${asset.trimStart ?? 0}"></label>
            <label>끝(초)<input type="number" class="trim-end" min="0.5" step="0.5" value="${asset.trimEnd ?? ''}" placeholder="전체"></label>
          </div>
        ` : ''}
        <div class="asset-actions">
          ${asset.mediaType === 'image' ? `<button type="button" class="mini-btn hero-pin ${isHero ? 'active' : ''}">${isHero ? '★ 시작프레임' : '☆ 시작지정'}</button>` : ''}
          <button type="button" class="mini-btn move-left" ${idx === 0 ? 'disabled' : ''}>◀</button>
          <button type="button" class="mini-btn move-right" ${idx === assets.length - 1 ? 'disabled' : ''}>▶</button>
          <button type="button" class="mini-btn toggle-enable ${asset.enabled !== false ? 'active' : ''}">${asset.enabled === false ? '제외됨' : '사용중'}</button>
          <button type="button" class="mini-btn del-asset">삭제</button>
        </div>
      </div>
    `;

    card.querySelector('.asset-thumb-box').addEventListener('click', () => {
      selectedAssetId = asset.id;
      previewOverride = null;
      renderAll();
    });

    card.querySelector('.hero-pin')?.addEventListener('click', async () => {
      try {
        appState = await api('/api/assets/update', {
          method: 'POST',
          body: JSON.stringify({action: 'set-hero', id: asset.id}),
        });
        renderAll();
        showToast(`1번 시작 프레임 변경됨: ${asset.label}`);
      } catch (err) {
        showToast(err.message);
      }
    });

    card.querySelector('.move-left')?.addEventListener('click', () => reorderAsset(idx, idx - 1));
    card.querySelector('.move-right')?.addEventListener('click', () => reorderAsset(idx, idx + 1));
    card.querySelector('.toggle-enable')?.addEventListener('click', () => updateAsset(asset.id, {enabled: asset.enabled === false}));
    card.querySelector('.del-asset')?.addEventListener('click', () => deleteAsset(asset.id));

    const startInput = card.querySelector('.trim-start');
    const endInput = card.querySelector('.trim-end');
    startInput?.addEventListener('change', () => updateAsset(asset.id, {trimStart: Number(startInput.value || 0)}));
    endInput?.addEventListener('change', () => updateAsset(asset.id, {trimEnd: endInput.value === '' ? '' : Number(endInput.value)}));

    wrap.appendChild(card);
  });
}

function renderPreview() {
  const screen = $('previewStage');
  const titleEl = $('stageTitle');

  if (previewOverride) {
    titleEl.textContent = previewOverride.title || '미리보기';
    if (previewOverride.type === 'video') {
      screen.innerHTML = `<video src="${previewOverride.url}" controls autoplay playsinline loop></video>`;
    } else {
      screen.innerHTML = `<img src="${previewOverride.url}" alt="미리보기">`;
    }
    return;
  }

  const selected = appState.assets.find(a => a.id === selectedAssetId) || appState.assets[0];
  if (appState.render.lastOutput && !selectedAssetId) {
    titleEl.textContent = `완성 필름 · ${appState.render.lastOutput.durationSec}초`;
    screen.innerHTML = `<video src="${appState.render.lastOutput.url}" controls playsinline></video>`;
    return;
  }

  if (!selected) {
    titleEl.textContent = '9:16 필름 미리보기';
    screen.innerHTML = `
      <div class="preview-placeholder">
        <div class="film-emblem">✦</div>
        <p>재료나 완성된 숏츠가<br>이 프레임에 표시됩니다</p>
        <span>스마트스토어 9:16 세로 규격</span>
      </div>`;
    return;
  }

  titleEl.textContent = selected.label;
  if (selected.mediaType === 'video') {
    screen.innerHTML = `<video src="${selected.url}" controls playsinline></video>`;
  } else {
    screen.innerHTML = `<img src="${selected.url}" alt="${selected.label}">`;
  }
}

function renderFactsAndOptions() {
  const {facts, product, options, bgm, flow} = appState;
  $('factSourcePill').textContent = product?.sourceLabel || '직접 입력 모드';
  if (document.activeElement !== $('factStyle')) $('factStyle').value = facts.style || '';
  if (document.activeElement !== $('factPrice')) $('factPrice').value = facts.price || '';
  if (document.activeElement !== $('factMaterial')) $('factMaterial').value = facts.material || '';
  if (document.activeElement !== $('factHeadline')) $('factHeadline').value = facts.headline || facts.name || '';
  if (document.activeElement !== $('factPoints')) $('factPoints').value = (facts.sellingPoints || []).join('\n');

  const colorWrap = $('colorPreviewWrap');
  const colorRow = $('colorChipRow');
  if (facts.colors && facts.colors.length) {
    colorWrap.hidden = false;
    colorRow.innerHTML = facts.colors.map(c =>
      `<span class="swatch-pill"><span class="swatch-dot" style="background:${c.hex || '#888'}"></span>${c.name}</span>`
    ).join('');
  } else {
    colorWrap.hidden = true;
  }

  $('bgmStatus').textContent = bgm
    ? `적용된 BGM: ${bgm.originalName}`
    : 'BGM 없음 (위 드롭존에 MP3/WAV 파일을 놓으면 자동 적용)';
  $('removeBgmBtn').hidden = !bgm;

  if ($('captionStyleSelect')) $('captionStyleSelect').value = options.captionStyle || 'reels-highlight';
  if ($('captionPositionSelect')) $('captionPositionSelect').value = options.captionPosition || 'safe-lower';
  if ($('transitionStyleSelect')) $('transitionStyleSelect').value = options.transitionStyle || 'fade';
  if ($('builtinBgmSelect')) $('builtinBgmSelect').value = options.builtinBgm ?? 'lounge-pad';
  if ($('includeSplitShowcaseCheck')) $('includeSplitShowcaseCheck').checked = options.includeSplitShowcase !== false;
  if ($('videoSpeedSelect')) $('videoSpeedSelect').value = String(options.videoSpeed ?? 1.3);
  $('targetDurationInput').value = options.targetDurationSec ?? 17.5;
  $('bgmVolumeInput').value = options.bgmVolume ?? 0.35;
  $('bgmVolLabel').textContent = `${Math.round((options.bgmVolume ?? 0.35) * 100)}%`;
  $('origVolumeInput').value = options.originalVolume ?? 0.8;
  $('origVolLabel').textContent = `${Math.round((options.originalVolume ?? 0.8) * 100)}%`;
  $('keepOriginalAudioCheck').checked = Boolean(options.keepOriginalAudio);
  $('showLogoCheck').checked = facts.showLogo !== false;
  $('showPriceCheck').checked = facts.showPrice !== false;
  $('showColorsCheck').checked = facts.showColors !== false;
  $('includeEndingCheck').checked = options.includeEnding !== false;

  renderFlowModels(appState.flowModels, flow.modelId);
  renderFlowPresets(appState.flowPresets, flow.presetId);
  if (document.activeElement !== $('flowCustomDirection')) {
    $('flowCustomDirection').value = flow.customDirection || '';
  }
  $('flowDurationSelect').value = String(flow.durationSec || 15);
  if ($('flowGarmentCategorySelect')) {
    $('flowGarmentCategorySelect').value = flow.garmentCategory || 'auto';
  }
  if ($('garmentResolvedTag')) {
    const catMap = {top: '현재: 👕 상의', outer: '현재: 🧥 아우터', bottom: '현재: 👖 하의'};
    $('garmentResolvedTag').textContent = catMap[flow.resolvedCategory] ? `(${catMap[flow.resolvedCategory]})` : '';
  }
  $('autoChainRenderCheck').checked = flow.autoChainRender !== false;
  if ($('flowRemoteAutoBtn')) {
    const btn = $('flowRemoteAutoBtn');
    const spanEl = btn.querySelector('span');
    btn.disabled = Boolean(flow.busy || appState.render?.busy);
    if (spanEl) {
      spanEl.textContent = flow.busy
        ? '⏳ Flow 자동 제작 중…'
        : '⚡ 원클릭 Flow 자동 제작';
    }
  }
  if ($('flowRemoteCancelBtn')) {
    $('flowRemoteCancelBtn').hidden = !flow.busy;
  }
  if ($('flowLaunchBtn')) {
    const spanEl = $('flowLaunchBtn').querySelector('span');
    if (spanEl) {
      spanEl.textContent = flow.watchingDownloads
        ? '🟢 수동 감시 중 · Flow 새 탭 + 프롬프트 복사'
        : '📋 수동 모드 · 프롬프트 복사 + Flow 새 탭';
    }
  }
  $('flowCreditBadge').textContent = `예상 약 ${flow.estimatedCredits} 크레딧`;

  const heroBox = $('heroFrameBox');
  const heroItem = (flow.preparedImages || [])[0];
  if (heroBox && heroItem) {
    heroBox.hidden = false;
    $('heroFrameImg').src = heroItem.url;
    $('heroFrameName').textContent = `대표 시작 사진: ${heroItem.filename} (2단계 카드에서 변경 가능)`;
    const dlLink = $('heroDownloadLink');
    if (dlLink) {
      const sep = heroItem.url.includes('?') ? '&' : '?';
      dlLink.href = `${heroItem.url}${sep}download=1`;
      dlLink.setAttribute('download', heroItem.filename);
    }
  } else if (heroBox) {
    heroBox.hidden = true;
  }

  const statusBox = $('flowStatusBox');
  if (flow.message) {
    statusBox.hidden = false;
    const actionsHtml = (flow.actions || []).length
      ? `<div style="margin-top:6px;opacity:0.85;">· ${flow.actions.join('<br>· ')}</div>`
      : '';
    statusBox.innerHTML = `${flow.message}${actionsHtml}`;
  } else {
    statusBox.hidden = true;
  }

  const promptWrap = $('flowPromptWrap');
  if (flow.promptEn) {
    promptWrap.hidden = false;
    $('flowSummaryKo').textContent = flow.summaryKo || '';
    if (document.activeElement !== $('flowPromptText')) {
      $('flowPromptText').value = flow.promptEn;
    }
  } else {
    promptWrap.hidden = true;
  }
}

function renderProgressAndOutputs() {
  const {render, outputs, logs} = appState;
  $('renderStageText').textContent = render.stage || '대기 중';
  $('renderPercentText').textContent = `${render.progress || 0}%`;
  $('renderProgressFill').style.width = `${render.progress || 0}%`;
  $('renderBtn').disabled = Boolean(render.busy);

  const errEl = $('renderErrorText');
  if (render.error) {
    errEl.hidden = false;
    errEl.textContent = render.error;
  } else {
    errEl.hidden = true;
  }

  $('outputCountLabel').textContent = `${outputs.length}편`;
  const listEl = $('outputsList');
  if (!outputs.length) {
    listEl.innerHTML = `<p class="muted-line">아직 완성된 영상이 없습니다.</p>`;
  } else {
    listEl.innerHTML = '';
    for (const out of outputs) {
      const row = document.createElement('div');
      row.className = 'output-item';
      row.innerHTML = `
        <span class="output-name" title="${out.filename}">▶ ${out.filename}</span>
        <span class="output-size">${(out.sizeBytes / (1024 * 1024)).toFixed(1)}MB</span>
      `;
      row.addEventListener('click', () => {
        previewOverride = {type: 'video', url: out.url, title: out.filename};
        renderPreview();
      });
      listEl.appendChild(row);
    }
  }

  if ($('activityLogs')) $('activityLogs').innerHTML = (logs || []).slice(0, 18).map(l =>
    `<li><span class="log-time">${l.time}</span><span>${l.message}</span></li>`
  ).join('');
}

function renderAll() {
  if (!appState) return;
  renderEnv(appState.env);
  renderRecentStyles(appState.recentStyles);
  renderFilmStrip(appState.assets);
  renderFactsAndOptions();
  renderProgressAndOutputs();
  renderPreview();
}

async function refreshState() {
  appState = await api('/api/state');
  renderAll();
  const shouldPoll = Boolean(appState.render.busy || appState.flow?.busy || appState.flow?.watchingDownloads);
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(async () => {
      try {
        const prevRenderBusy = Boolean(appState?.render?.busy);
        appState = await api('/api/state');
        const nowRenderBusy = Boolean(appState?.render?.busy);
        const keepPolling = Boolean(nowRenderBusy || appState?.flow?.busy || appState?.flow?.watchingDownloads);
        if (prevRenderBusy && !nowRenderBusy && appState.render.lastOutput) {
          selectedAssetId = null;
          previewOverride = {
            type: 'video',
            url: appState.render.lastOutput.url,
            title: `완성 필름 · ${appState.render.lastOutput.durationSec}초`,
          };
          showToast('🎉 한글 자막·로고 최종 숏츠 제작이 완료되었습니다!');
        }
        renderAll();
        if (!keepPolling) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch {}
    }, 1500);
  }
}

async function loadProduct() {
  const val = $('styleInput').value.trim();
  if (!val) return showToast('품번 6자리 또는 지오다노 공식몰 주소를 입력해 주세요.');
  $('loadProductBtn').disabled = true;
  $('loadProductBtn').textContent = '불러오는 중…';
  try {
    appState = await api('/api/load-product', {
      method: 'POST',
      body: JSON.stringify({input: val, autoCutout: false}),
    });
    selectedAssetId = appState.assets[0]?.id || null;
    previewOverride = null;
    renderAll();
    const activeOff = appState.assets.filter(a => a.kind === 'official' && a.enabled !== false).length;
    const activeMan = appState.assets.filter(a => a.kind === 'mannequin' && a.enabled !== false).length;
    const activeVid = appState.assets.filter(a => a.mediaType === 'video' && a.enabled !== false).length;
    showToast(`자동 수집 완료: 모델 ${activeOff}장 · 마네킨 정면 ${activeMan}장${activeVid ? ` · 영상 ${activeVid}개` : ''}`);
  } catch (err) {
    showToast(err.message);
  } finally {
    $('loadProductBtn').disabled = false;
    $('loadProductBtn').textContent = '품번 불러오기';
  }
}

async function uploadFiles(files, defaultKind) {
  for (const file of files) {
    const ext = file.name.toLowerCase();
    let kind = defaultKind;
    if (/\.(mp3|wav|m4a|aac|ogg)$/.test(ext)) kind = 'bgm';
    else if (/\.(mp4|mov|webm|mkv)$/.test(ext)) kind = defaultKind === 'flow' ? 'flow' : 'video';
    else kind = 'mannequin';

    try {
      showToast(`불러오는 중: ${file.name}`);
      appState = await api(`/api/upload?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      if (kind !== 'bgm') {
        selectedAssetId = appState.assets[kind === 'flow' ? 0 : appState.assets.length - 1]?.id || null;
        previewOverride = null;
      }
      renderAll();
    } catch (err) {
      showToast(err.message);
    }
  }
  showToast('파일을 안전하게 복사해 추가했습니다. (PC 원본 유지)');
}

async function runCutout(targetId) {
  try {
    showToast('공식몰 사진 누끼 추출 중…');
    appState = await api(`/api/cutout/${encodeURIComponent(targetId)}`, {method: 'POST'});
    renderAll();
    showToast('로컬 무료 누끼 추출 완료!');
  } catch (err) {
    showToast(err.message);
  }
}

async function updateAsset(id, patch) {
  try {
    appState = await api('/api/assets/update', {
      method: 'POST',
      body: JSON.stringify({id, ...patch}),
    });
    renderAll();
  } catch (err) {
    showToast(err.message);
  }
}

async function reorderAsset(fromIdx, toIdx) {
  if (toIdx < 0 || toIdx >= appState.assets.length) return;
  const ids = appState.assets.map(a => a.id);
  const [moved] = ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, moved);
  appState = await api('/api/assets/update', {
    method: 'POST',
    body: JSON.stringify({action: 'reorder', order: ids}),
  });
  renderAll();
}

async function deleteAsset(id) {
  appState = await api('/api/assets/update', {
    method: 'POST',
    body: JSON.stringify({action: 'delete', id}),
  });
  if (selectedAssetId === id) selectedAssetId = appState.assets[0]?.id || null;
  renderAll();
}

let saveTimer = null;
function scheduleSaveFactsAndOptions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const sellingPoints = $('factPoints').value
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      appState = await api('/api/facts/update', {
        method: 'POST',
        body: JSON.stringify({
          facts: {
            style: $('factStyle').value,
            price: $('factPrice').value,
            material: $('factMaterial').value,
            headline: $('factHeadline').value,
            sellingPoints,
            showLogo: $('showLogoCheck').checked,
            showPrice: $('showPriceCheck').checked,
            showColors: $('showColorsCheck').checked,
          },
          options: {
            captionStyle: $('captionStyleSelect')?.value || 'reels-highlight',
            captionPosition: $('captionPositionSelect')?.value || 'safe-lower',
            transitionStyle: $('transitionStyleSelect')?.value || 'fade',
            builtinBgm: $('builtinBgmSelect')?.value ?? 'lounge-pad',
            includeSplitShowcase: $('includeSplitShowcaseCheck') ? $('includeSplitShowcaseCheck').checked : true,
            videoSpeed: Number($('videoSpeedSelect')?.value || 1.3),
            targetDurationSec: Number($('targetDurationInput').value || 17.5),
            bgmVolume: Number($('bgmVolumeInput').value || 0.35),
            originalVolume: Number($('origVolumeInput').value || 0.8),
            keepOriginalAudio: $('keepOriginalAudioCheck').checked,
            includeEnding: $('includeEndingCheck').checked,
          },
          flow: {
            modelId: $('flowModelSelect').value,
            garmentCategory: $('flowGarmentCategorySelect')?.value || 'auto',
            durationSec: Number($('flowDurationSelect').value || 15),
            presetId: appState?.flow?.presetId || 'top-signature-lookbook',
            customDirection: $('flowCustomDirection').value,
          },
        }),
      });
      renderFactsAndOptions();
    } catch {}
  }, 260);
}

function wireDropZone(zoneEl, inputEl, defaultKind) {
  zoneEl.addEventListener('click', () => inputEl.click());
  inputEl.addEventListener('change', () => {
    if (inputEl.files?.length) uploadFiles([...inputEl.files], defaultKind);
    inputEl.value = '';
  });
  zoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    zoneEl.classList.add('dragover');
  });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files], defaultKind);
  });
}

// 이벤트 연결
$('loadProductBtn').addEventListener('click', loadProduct);
$('styleInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadProduct(); });

wireDropZone($('mannequinDrop'), $('mannequinFileInput'), 'mannequin');
wireDropZone($('mediaDrop'), $('mediaFileInput'), 'video');

$('openFlowPrepBtn')?.addEventListener('click', () => api('/api/open-folder', {method: 'POST', body: JSON.stringify({target: 'flow-prep'})}));
$('openOutputsBtn')?.addEventListener('click', () => api('/api/open-folder', {method: 'POST', body: JSON.stringify({target: 'outputs'})}));

$('flowRemoteAutoBtn')?.addEventListener('click', async () => {
  try {
    const btn = $('flowRemoteAutoBtn');
    if (btn) btn.disabled = true;
    appState = await api('/api/flow/remote-auto', {
      method: 'POST',
      body: JSON.stringify({
        modelId: $('flowModelSelect').value,
        garmentCategory: $('flowGarmentCategorySelect')?.value || 'auto',
        durationSec: Number($('flowDurationSelect').value || 15),
        presetId: appState?.flow?.presetId || 'top-signature-lookbook',
        customDirection: $('flowCustomDirection').value,
        promptText: $('flowPromptText').value,
        autoChainRender: $('autoChainRenderCheck').checked,
      }),
    });
    renderState();
    schedulePolling();
    showToast('⚡ 원클릭 Flow 끝까지 자동화를 시작했습니다! 전용 Chrome 창에서 진행 상황을 확인하세요.');
  } catch (err) {
    renderState();
    showToast(err.message, true);
  }
});

$('flowRemoteOpenBtn')?.addEventListener('click', async () => {
  try {
    appState = await api('/api/flow/remote-open', {method: 'POST'});
    renderState();
    showToast('🌐 전용 Flow Chrome 창을 열었습니다. 최초 1회 Google 로그인 후 원클릭 자동화를 눌러주세요!');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('flowRemoteCancelBtn')?.addEventListener('click', async () => {
  try {
    appState = await api('/api/flow/remote-cancel', {method: 'POST'});
    renderState();
    showToast('Flow 자동 실행 중지를 요청했습니다.');
  } catch (err) {
    showToast(err.message, true);
  }
});

$('flowLaunchBtn')?.addEventListener('click', async () => {
  // <a target="_blank"> 기본 동작으로 평소 쓰시는 브라우저 새 탭에 Flow가 즉시 열리고, 동시에 대표 사진·프롬프트 복사·다운로드 감시가 시작됩니다.
  try {
    const currentPrompt = $('flowPromptText').value || appState?.flow?.promptEn || '';
    if (currentPrompt) {
      navigator.clipboard.writeText(currentPrompt).catch(() => {});
    }
    appState = await api('/api/flow/launch', {
      method: 'POST',
      body: JSON.stringify({
        modelId: $('flowModelSelect').value,
        garmentCategory: $('flowGarmentCategorySelect')?.value || 'auto',
        durationSec: Number($('flowDurationSelect').value || 15),
        presetId: appState?.flow?.presetId || 'top-signature-lookbook',
        customDirection: $('flowCustomDirection').value,
        promptText: $('flowPromptText').value,
        autoChainRender: $('autoChainRenderCheck').checked,
      }),
    });
    renderAll();
    refreshState();
    const nextPrompt = appState?.flow?.promptEn || '';
    if (nextPrompt) {
      navigator.clipboard.writeText(nextPrompt).catch(() => {});
    }
    showToast('프롬프트 복사 + 사진 폴더 열기 + 다운로드 자동 감시가 시작되었습니다!');
  } catch (err) {
    showToast(err.message);
  }
});

$('flowImportBtn').addEventListener('click', async () => {
  try {
    appState = await api('/api/flow/import-latest', {method: 'POST'});
    selectedAssetId = appState.assets[0]?.id || null;
    previewOverride = null;
    renderAll();
    showToast('최신 Flow 영상을 불러왔습니다! 원본 변형 여부를 미리보기로 확인해 주세요.');
  } catch (err) {
    showToast(err.message);
  }
});

$('copyPromptBtn').addEventListener('click', async () => {
  const txt = $('flowPromptText').value || appState?.flow?.promptEn || '';
  if (!txt) return showToast('먼저 9:16 준비 버튼을 눌러 프롬프트를 생성해 주세요.');
  try {
    await navigator.clipboard.writeText(txt);
    showToast('원본 보존 프롬프트를 클립보드에 복사했습니다.');
  } catch {
    $('flowPromptText').select();
    document.execCommand('copy');
    showToast('프롬프트를 복사했습니다.');
  }
});

$('removeBgmBtn').addEventListener('click', async () => {
  appState = await api('/api/assets/update', {method: 'POST', body: JSON.stringify({action: 'remove-bgm'})});
  renderAll();
});

$('renderBtn').addEventListener('click', async () => {
  try {
    await api('/api/facts/update', {
      method: 'POST',
      body: JSON.stringify({
        facts: {
          style: $('factStyle').value,
          price: $('factPrice').value,
          material: $('factMaterial').value,
          headline: $('factHeadline').value,
          sellingPoints: $('factPoints').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5),
          showLogo: $('showLogoCheck').checked,
          showPrice: $('showPriceCheck').checked,
          showColors: $('showColorsCheck').checked,
        },
        options: {
          captionStyle: $('captionStyleSelect')?.value || 'reels-highlight',
            captionPosition: $('captionPositionSelect')?.value || 'safe-lower',
          transitionStyle: $('transitionStyleSelect')?.value || 'fade',
          builtinBgm: $('builtinBgmSelect')?.value ?? 'lounge-pad',
          includeSplitShowcase: $('includeSplitShowcaseCheck') ? $('includeSplitShowcaseCheck').checked : true,
          videoSpeed: Number($('videoSpeedSelect')?.value || 1.3),
            targetDurationSec: Number($('targetDurationInput').value || 17.5),
          bgmVolume: Number($('bgmVolumeInput').value || 0.35),
          originalVolume: Number($('origVolumeInput').value || 0.8),
          keepOriginalAudio: $('keepOriginalAudioCheck').checked,
          includeEnding: $('includeEndingCheck').checked,
        },
      }),
    });
    appState = await api('/api/render', {method: 'POST', body: JSON.stringify({})});
    renderAll();
    refreshState();
  } catch (err) {
    showToast(err.message);
  }
});

$('refreshPageBtn')?.addEventListener('click', () => {
  window.location.reload();
});

$('resetBtn').addEventListener('click', async () => {
  try {
    appState = await api('/api/reset', {method: 'POST'});
    selectedAssetId = null;
    previewOverride = null;
    $('styleInput').value = '';
    renderAll();
    showToast('새 작업실을 열었습니다.');
  } catch (err) {
    showToast(err.message);
  }
});

$('themeToggle').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('atelier-theme', next);
  $('themeToggleText').textContent = next === 'dark' ? '라이트' : '다크';
});

const savedTheme = localStorage.getItem('atelier-theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', savedTheme);
  $('themeToggleText').textContent = savedTheme === 'dark' ? '라이트' : '다크';
}

[
  'factStyle', 'factPrice', 'factMaterial', 'factHeadline', 'factPoints',
  'captionStyleSelect', 'captionPositionSelect', 'transitionStyleSelect', 'builtinBgmSelect', 'includeSplitShowcaseCheck',
  'videoSpeedSelect', 'targetDurationInput', 'bgmVolumeInput', 'origVolumeInput',
  'keepOriginalAudioCheck', 'showLogoCheck', 'showPriceCheck', 'showColorsCheck', 'includeEndingCheck',
  'flowModelSelect', 'flowDurationSelect', 'flowCustomDirection',
].forEach(id => {
  const el = $(id);
  el?.addEventListener('input', () => {
    if (id === 'bgmVolumeInput') $('bgmVolLabel').textContent = `${Math.round(Number(el.value) * 100)}%`;
    if (id === 'origVolumeInput') $('origVolLabel').textContent = `${Math.round(Number(el.value) * 100)}%`;
    scheduleSaveFactsAndOptions();
  });
  el?.addEventListener('change', scheduleSaveFactsAndOptions);
});

$('flowGarmentCategorySelect')?.addEventListener('change', async () => {
  try {
    appState = await api('/api/facts/update', {
      method: 'POST',
      body: JSON.stringify({
        flow: {
          modelId: $('flowModelSelect').value,
          garmentCategory: $('flowGarmentCategorySelect').value,
          durationSec: Number($('flowDurationSelect').value || 15),
          customDirection: $('flowCustomDirection').value,
        },
      }),
    });
    renderFactsAndOptions();
    showToast('선택한 의류 구분에 맞춰 프롬프트와 추천 연출을 재설정했습니다!');
  } catch (err) {
    showToast(err.message);
  }
});

let promptEditTimer = null;
$('flowPromptText')?.addEventListener('input', () => {
  clearTimeout(promptEditTimer);
  promptEditTimer = setTimeout(async () => {
    try {
      appState = await api('/api/facts/update', {
        method: 'POST',
        body: JSON.stringify({flow: {promptEn: $('flowPromptText').value}}),
      });
    } catch {}
  }, 300);
});

refreshState();


// === 초대형 9:16 극장 크게 보기 모달 ===
function closeFilmLightbox() {
  const modal = $('filmLightboxModal');
  const body = $('lightboxBody');
  if (body) body.innerHTML = '';
  if (modal) modal.hidden = true;
}

function openFilmLightbox() {
  const stage = $('previewStage');
  const modal = $('filmLightboxModal');
  const body = $('lightboxBody');
  if (!stage || !modal || !body) return;
  const vid = stage.querySelector('video');
  const img = stage.querySelector('img');
  if (!vid && !img) {
    showToast('먼저 미리보기할 완성 필름이나 재료를 선택해 주세요.');
    return;
  }
  const titleEl = $('lightboxTitle');
  if (titleEl) titleEl.textContent = $('stageTitle')?.textContent || '완성 필름 크게 보기';
  body.innerHTML = '';
  if (vid) {
    try { vid.pause(); } catch {}
    const bigVid = document.createElement('video');
    bigVid.src = vid.currentSrc || vid.src;
    bigVid.controls = true;
    bigVid.autoplay = true;
    bigVid.playsInline = true;
    bigVid.loop = false;
    body.appendChild(bigVid);
  } else if (img) {
    const bigImg = document.createElement('img');
    bigImg.src = img.currentSrc || img.src;
    bigImg.alt = img.alt || '크게 보기';
    body.appendChild(bigImg);
  }
  modal.hidden = false;
}

$('expandPreviewBtn')?.addEventListener('click', openFilmLightbox);
$('closeLightboxBtn')?.addEventListener('click', closeFilmLightbox);
$('lightboxBackdrop')?.addEventListener('click', closeFilmLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('filmLightboxModal') && !$('filmLightboxModal').hidden) {
    closeFilmLightbox();
  }
});
