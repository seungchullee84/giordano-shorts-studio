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
  const wrap = $('envPills');
  if (!wrap) return;
  const items = [
    {label: 'FFmpeg', ok: env.ffmpeg},
    {label: 'Chrome', ok: env.chrome},
    {label: '등록기 연동', ok: env.registrarLinked},
    {label: '사진폴더', ok: env.photoFolderLinked},
  ];
  const sig = JSON.stringify(items);
  if (wrap.dataset.sig === sig) return;
  wrap.dataset.sig = sig;
  wrap.innerHTML = items.map(it =>
    `<span class="env-chip ${it.ok ? 'ok' : ''}">${it.ok ? '●' : '○'} ${it.label}</span>`
  ).join('');
}

function renderRecentStyles(list) {
  const wrap = $('recentStylesWrap');
  const container = $('recentStyleChips');
  if (!list || !list.length) {
    wrap.hidden = true;
    container.dataset.sig = '';
    return;
  }
  wrap.hidden = false;
  const slice = list.slice(0, 8);
  const sig = JSON.stringify(slice.map(it => [it.style, it.name]));
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.innerHTML = '';
  for (const item of slice) {
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
    const tabsSig = JSON.stringify({categories, selectedPresetCategory, total: presets.length});
    if (tabsWrap.dataset.sig !== tabsSig) {
      tabsWrap.dataset.sig = tabsSig;
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
  }

  const filtered = selectedPresetCategory === '전체'
    ? presets
    : presets.filter(p => p.category === selectedPresetCategory);

  const presetsSig = JSON.stringify({
    selectedPresetCategory,
    currentPresetId,
    ids: filtered.map(p => [p.id, p.label]),
  });
  if (wrap.dataset.sig === presetsSig) return;
  wrap.dataset.sig = presetsSig;

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

  const heroAssetId = appState?.flow?.heroAssetId || '';
  const sig = JSON.stringify({
    selectedAssetId,
    heroAssetId,
    items: (assets || []).map(a => [
      a.id, a.url, a.kind, a.mediaType, a.label, a.enabled !== false, a.trimStart ?? 0, a.trimEnd ?? '',
    ]),
  });
  if (wrap.dataset.sig === sig) return;
  wrap.dataset.sig = sig;

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

  let nextTitle = '9:16 필름 미리보기';
  let mediaKey = 'placeholder';
  let nextHtml = `
      <div class="preview-placeholder">
        <div class="film-emblem">✦</div>
        <p>재료나 완성된 숏츠가<br>이 프레임에 표시됩니다</p>
        <span>스마트스토어 9:16 세로 규격</span>
      </div>`;

  if (previewOverride) {
    nextTitle = previewOverride.title || '미리보기';
    if (previewOverride.type === 'video') {
      mediaKey = `video::${previewOverride.url}`;
      nextHtml = `<video src="${previewOverride.url}" controls autoplay playsinline loop></video>`;
    } else {
      mediaKey = `image::${previewOverride.url}`;
      nextHtml = `<img src="${previewOverride.url}" alt="미리보기">`;
    }
  } else {
    const selected = appState.assets.find(a => a.id === selectedAssetId) || appState.assets[0];
    const latestDiskOut = appState.outputs?.[0] || null;
    const memOut = appState.render?.lastOutput || null;
    const sameStyleNewer = Boolean(
      latestDiskOut && memOut &&
      latestDiskOut.filename.split('_')[0] === memOut.filename.split('_')[0] &&
      latestDiskOut.filename > memOut.filename
    );
    const activeOut = sameStyleNewer ? latestDiskOut : memOut;
    if (activeOut && !selectedAssetId) {
      nextTitle = activeOut.durationSec
        ? `완성 필름 · ${activeOut.durationSec}초`
        : `최신 완성 필름 · ${activeOut.filename}`;
      mediaKey = `video::${activeOut.url}`;
      nextHtml = `<video src="${activeOut.url}" controls playsinline></video>`;
    } else if (selected) {
      nextTitle = selected.label;
      if (selected.mediaType === 'video') {
        mediaKey = `video::${selected.url}`;
        nextHtml = `<video src="${selected.url}" controls playsinline></video>`;
      } else {
        mediaKey = `image::${selected.url}`;
        nextHtml = `<img src="${selected.url}" alt="${selected.label}">`;
      }
    }
  }

  if (titleEl && titleEl.textContent !== nextTitle) {
    titleEl.textContent = nextTitle;
  }
  if (screen.dataset.mediaKey === mediaKey) {
    return;
  }
  screen.dataset.mediaKey = mediaKey;
  screen.innerHTML = nextHtml;
}

let bgmPreviewAudio = null;
let bgmPreviewPlayingId = '';

function stopBgmPreview() {
  if (bgmPreviewAudio) {
    try {
      bgmPreviewAudio.pause();
      bgmPreviewAudio.currentTime = 0;
    } catch {}
    bgmPreviewAudio = null;
  }
  bgmPreviewPlayingId = '';
  const btn = $('previewBgmBtn');
  if (btn) {
    btn.classList.remove('active');
    btn.textContent = '▶ 미리듣기';
  }
}

async function toggleBgmPreview(forceTrackId = '') {
  const sel = $('builtinBgmSelect');
  const targetId = forceTrackId || sel?.value || 'lounge-pad';
  const btn = $('previewBgmBtn');
  if (!targetId || targetId === 'none') {
    stopBgmPreview();
    return showToast('무음 상태입니다. 다른 배경 음악을 선택해 주세요.');
  }
  if (!forceTrackId && bgmPreviewAudio && bgmPreviewPlayingId === targetId && !bgmPreviewAudio.paused) {
    stopBgmPreview();
    return;
  }
  stopBgmPreview();
  if (btn) {
    btn.classList.add('active');
    btn.textContent = '⏳ 준비 중…';
  }
  try {
    const audio = new Audio(`/api/bgm/preview?id=${encodeURIComponent(targetId)}`);
    audio.volume = 0.8;
    bgmPreviewAudio = audio;
    bgmPreviewPlayingId = targetId;
    audio.addEventListener('ended', () => {
      if (bgmPreviewAudio === audio) stopBgmPreview();
    });
    audio.addEventListener('error', () => {
      if (bgmPreviewAudio === audio) {
        stopBgmPreview();
        showToast('배경 음악 미리듣기를 불러오지 못했습니다.');
      }
    });
    await audio.play();
    if (bgmPreviewAudio === audio && btn) {
      btn.textContent = '■ 정지';
    }
  } catch (err) {
    stopBgmPreview();
    showToast('미리듣기 재생 오류: ' + (err?.message || '잠시 후 다시 시도해 주세요.'));
  }
}

function renderBgmSelect(state) {
  const sel = $('builtinBgmSelect');
  if (!sel || !state) return;
  const presets = state.builtinBgmPresets || [];
  const customs = state.customBgmTracks || [];
  const desired = state.options?.builtinBgm ?? 'lounge-pad';
  const sig = JSON.stringify({p: presets.map(x => x.id), c: customs.map(x => [x.id, x.label])});
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    if (customs.length) {
      const grpCustom = document.createElement('optgroup');
      grpCustom.label = `내 MP3/WAV 보관함 (${customs.length}곡 · 바탕화면 숏츠BGM)`;
      for (const tr of customs) {
        const opt = document.createElement('option');
        opt.value = tr.id;
        opt.textContent = tr.label;
        grpCustom.appendChild(opt);
      }
      sel.appendChild(grpCustom);
    }
    if (presets.length) {
      const grpBuiltin = document.createElement('optgroup');
      grpBuiltin.label = '내장 저작권 무료 BGM (8종)';
      for (const pr of presets) {
        const opt = document.createElement('option');
        opt.value = pr.id;
        opt.textContent = pr.label;
        grpBuiltin.appendChild(opt);
      }
      sel.appendChild(grpBuiltin);
    }
  }
  if ([...sel.options].some(o => o.value === desired)) {
    sel.value = desired;
  }
}

function renderTrendStrategy(strategy) {
  const box = $('trendCardBox');
  if (!box) return;
  if (!strategy || !strategy.recommended) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if ($('trendBadgeText')) $('trendBadgeText').textContent = strategy.badge || '';
  if ($('trendClicheLine')) $('trendClicheLine').textContent = `🚫 피할 클리셰: ${strategy.clicheAvoid || ''}`;
  if ($('trendFormatTip')) $('trendFormatTip').textContent = strategy.formatTip || '';
  if ($('trendCaptionTip')) $('trendCaptionTip').textContent = strategy.captionTip || '';
  if ($('trendTimingTip')) $('trendTimingTip').textContent = strategy.timingTip || '';
  if ($('trendBgmTip')) $('trendBgmTip').textContent = strategy.bgmTip || '';
  const pills = $('trendRecPills');
  if (pills) {
    const r = strategy.recommended;
    const shortPreset = String(r.presetLabel || '').replace(/\s*\([^)]*\)/g, '');
    const shortBgm = String(r.builtinBgmLabel || '').replace(/\s*\([^)]*\)/g, '');
    const chips = [
      `연출: ${shortPreset}`,
      `자막: ${r.captionStyleLabel}`,
      `위치: ${r.captionPositionLabel}`,
      `속도: ${r.videoSpeed}배`,
      `전환: ${r.transitionLabel}`,
      `BGM: ${shortBgm}`,
    ];
    const sig = JSON.stringify(chips);
    if (pills.dataset.sig !== sig) {
      pills.dataset.sig = sig;
      pills.innerHTML = chips.map(t => `<span class="trend-rec-chip">${t}</span>`).join('');
    }
  }
}

function renderHookCandidates(candidates, currentHook) {
  const box = $('hookCandidatesBox');
  if (!box) return;
  const sig = JSON.stringify({
    current: String(currentHook || '').trim(),
    list: (candidates || []).map(it => [it.type, it.text]),
  });
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!candidates || !candidates.length) {
    box.innerHTML = '<div class="hook-empty-note">품번을 먼저 불러오면 확인된 상품 팩트 기반 후킹 멘트 10개가 자동 생성됩니다.</div>';
    return;
  }
  box.innerHTML = '';
  candidates.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = String(currentHook || '').trim() === String(item.text || '').trim();
    btn.className = 'hook-candidate-item' + (isSelected ? ' active' : '');
    btn.innerHTML = `<span class="hook-type-tag ${item.type === '문제제기' ? 'problem' : 'curiosity'}">${idx + 1}. ${item.type}</span><span class="hook-item-text">${item.text}</span>`;
    btn.addEventListener('click', () => {
      if ($('factHookText')) $('factHookText').value = item.text;
      scheduleSaveFactsAndOptions();
      box.hidden = true;
      if ($('toggleHookPickerBtn')) $('toggleHookPickerBtn').textContent = '✨ 10개 추천';
      showToast(`🪝 ${idx + 1}번 후킹 멘트가 영상 첫 3초 자막에 적용되었습니다!`);
    });
    box.appendChild(btn);
  });
}

let lastSyncedStyleInput = '';

function renderFactsAndOptions() {
  const {facts, product, options, bgm, flow} = appState;
  $('factSourcePill').textContent = product?.sourceLabel || '직접 입력 모드';
  const styleInputEl = $('styleInput');
  if (styleInputEl && document.activeElement !== styleInputEl) {
    const loadedStyle = String(facts.style || product?.style || '').trim();
    if (loadedStyle && (!styleInputEl.value.trim() || lastSyncedStyleInput !== loadedStyle)) {
      styleInputEl.value = loadedStyle;
      lastSyncedStyleInput = loadedStyle;
    }
  }
  if (document.activeElement !== $('factStyle')) $('factStyle').value = facts.style || '';
  if (document.activeElement !== $('factPrice')) $('factPrice').value = facts.price || '';
  if (document.activeElement !== $('factMaterial')) $('factMaterial').value = facts.material || '';
  if ($('factHookText') && document.activeElement !== $('factHookText')) $('factHookText').value = facts.hookText || '';
  renderTrendStrategy(appState.trendStrategy || null);
  renderHookCandidates(appState.hookCandidates || [], facts.hookText || '');
  if (document.activeElement !== $('factHeadline')) $('factHeadline').value = facts.headline || facts.name || '';
  if (document.activeElement !== $('factPoints')) $('factPoints').value = (facts.sellingPoints || []).join('\n');

  const colorWrap = $('colorPreviewWrap');
  const colorRow = $('colorChipRow');
  if (facts.colors && facts.colors.length) {
    colorWrap.hidden = false;
    const colorSig = JSON.stringify(facts.colors.map(c => [c.name, c.hex || '#888']));
    if (colorRow.dataset.sig !== colorSig) {
      colorRow.dataset.sig = colorSig;
      colorRow.innerHTML = facts.colors.map(c =>
        `<span class="swatch-pill"><span class="swatch-dot" style="background:${c.hex || '#888'}"></span>${c.name}</span>`
      ).join('');
    }
  } else {
    colorWrap.hidden = true;
    colorRow.dataset.sig = '';
  }

  $('bgmStatus').textContent = bgm
    ? `적용된 BGM: ${bgm.originalName}`
    : 'BGM 없음 (위 드롭존에 MP3/WAV 파일을 놓으면 자동 적용)';
  $('removeBgmBtn').hidden = !bgm;

  const validFrame = ['white-studio', 'letterbox-black', 'top-header-full', 'fullscreen'].includes(options.frameLayout) ? options.frameLayout : 'white-studio';
  if ($('frameLayoutSelect')) {
    $('frameLayoutSelect').value = validFrame;
  }
  syncFrameThemeCards(validFrame);
  if ($('captionStyleSelect')) {
    const validStyle = ['reels-highlight', 'shopping-card', 'lookbook-center'].includes(options.captionStyle) ? options.captionStyle : 'reels-highlight';
    $('captionStyleSelect').value = validStyle;
  }
  if ($('captionPositionSelect')) $('captionPositionSelect').value = options.captionPosition || 'safe-lower';
  if ($('transitionStyleSelect')) $('transitionStyleSelect').value = options.transitionStyle || 'fade';
  renderBgmSelect(appState);
  if ($('includeSplitShowcaseCheck')) $('includeSplitShowcaseCheck').checked = options.includeSplitShowcase !== false;
  if ($('videoSpeedSelect')) $('videoSpeedSelect').value = String(options.videoSpeed ?? 1.2);
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
    const heroImg = $('heroFrameImg');
    if (heroImg && heroImg.dataset.src !== heroItem.url) {
      heroImg.dataset.src = heroItem.url;
      heroImg.src = heroItem.url;
    }
    const nextHeroName = `대표 시작 사진: ${heroItem.filename} (2단계 카드에서 변경 가능)`;
    if ($('heroFrameName').textContent !== nextHeroName) $('heroFrameName').textContent = nextHeroName;
    const dlLink = $('heroDownloadLink');
    if (dlLink) {
      const sep = heroItem.url.includes('?') ? '&' : '?';
      const nextHref = `${heroItem.url}${sep}download=1`;
      if (dlLink.dataset.href !== nextHref) {
        dlLink.dataset.href = nextHref;
        dlLink.href = nextHref;
        dlLink.setAttribute('download', heroItem.filename);
      }
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
    const nextStatusHtml = `${flow.message}${actionsHtml}`;
    if (statusBox.dataset.html !== nextStatusHtml) {
      statusBox.dataset.html = nextStatusHtml;
      statusBox.innerHTML = nextStatusHtml;
    }
  } else {
    statusBox.hidden = true;
    statusBox.dataset.html = '';
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

let activePublishPlatform = 'clip';
let publishEditsStyleKey = '';
let publishManualEdits = {
  clip: {title: null, body: null},
  shorts: {title: null, body: null, comment: null},
  reels: {body: null},
};

function resetPublishManualEdits(styleKey = '') {
  publishEditsStyleKey = styleKey;
  publishManualEdits = {
    clip: {title: null, body: null},
    shorts: {title: null, body: null, comment: null},
    reels: {body: null},
  };
}

async function copyTextSafe(text, label) {
  const val = String(text || '').trim();
  if (!val) return showToast('복사할 내용이 없습니다.');
  try {
    await navigator.clipboard.writeText(val);
    showToast(`📋 ${label} 복사 완료! 업로드 화면에 Ctrl+V 하세요.`);
  } catch {
    showToast('복사에 실패했습니다. 텍스트를 직접 선택해 복사해 주세요.');
  }
}

function renderPublishKit() {
  const kit = appState?.publishKit;
  const settings = appState?.publishSettings || {};
  const badge = $('publishStoreBadge');
  if (badge) {
    badge.textContent = kit?.effectiveUrl
      ? (kit.usingProductUrl ? '✓ 개별 상품 URL 적용' : '통합 스토어 주소 사용 중')
      : '스토어 URL 미설정';
    badge.className = 'mini-label ' + (kit?.usingProductUrl ? 'url-badge-direct' : '');
  }
  const styleTag = $('productUrlStyleTag');
  if (styleTag) {
    const st = appState?.facts?.style || '';
    styleTag.textContent = st ? `(품번 ${st} 자동 기억)` : '(품번별 자동 기억)';
  }
  const searchLink = $('searchInMyStoreLink');
  if (searchLink) {
    searchLink.href = kit?.baseStoreUrl || settings.storeUrl || kit?.storeSearchUrl || 'https://shopping.naver.com/';
  }
  if ($('publishStoreUrlInput') && document.activeElement !== $('publishStoreUrlInput')) {
    $('publishStoreUrlInput').value = settings.storeUrl || '';
  }
  if ($('factProductUrlInput') && document.activeElement !== $('factProductUrlInput')) {
    $('factProductUrlInput').value = shortenProductUrlClient(appState?.facts?.productUrl || '');
  }
  if (!kit) return;

  document.querySelectorAll('#publishPlatformTabs button[data-platform]').forEach(b => {
    b.classList.toggle('active', b.dataset.platform === activePublishPlatform);
  });

  const tipEl = $('publishPlatformTip');
  const titleWrap = $('publishTitleWrap');
  const titleOut = $('publishTitleOut');
  const bodyLabel = $('publishBodyLabel');
  const bodyOut = $('publishBodyOut');
  const commentWrap = $('publishCommentWrap');
  const commentOut = $('publishCommentOut');
  const uploadLink = $('openPlatformUploadLink');
  const metaLink = $('openMetaSuiteLink');

  const curKey = `${appState?.facts?.style || ''}::${kit.effectiveUrl || ''}`;
  if (publishEditsStyleKey && publishEditsStyleKey !== curKey) {
    resetPublishManualEdits(curKey);
  } else if (!publishEditsStyleKey) {
    publishEditsStyleKey = curKey;
  }

  if (activePublishPlatform === 'clip') {
    if (tipEl) tipEl.textContent = `💡 ${kit.clip.tip}`;
    if (titleWrap) titleWrap.hidden = false;
    if (titleOut && document.activeElement !== titleOut) {
      titleOut.value = publishManualEdits.clip.title ?? (kit.clip.title || '');
    }
    if (bodyLabel) bodyLabel.textContent = '클립 본문 · 스토어 URL · 해시태그 (직접 수정 가능)';
    if (bodyOut && document.activeElement !== bodyOut) {
      bodyOut.value = publishManualEdits.clip.body ?? (kit.clip.body || '');
    }
    if (commentWrap) commentWrap.hidden = true;
    if (uploadLink) {
      uploadLink.href = kit.clip.uploadUrl;
      uploadLink.textContent = '🟢 네이버 클립 열기';
    }
    if (metaLink) metaLink.hidden = true;
  } else if (activePublishPlatform === 'shorts') {
    if (tipEl) tipEl.textContent = `💡 ${kit.shorts.tip}`;
    if (titleWrap) titleWrap.hidden = false;
    if (titleOut && document.activeElement !== titleOut) {
      titleOut.value = publishManualEdits.shorts.title ?? (kit.shorts.title || '');
    }
    if (bodyLabel) bodyLabel.textContent = '쇼츠 설명란 · 스토어 URL · 해시태그 (직접 수정 가능)';
    if (bodyOut && document.activeElement !== bodyOut) {
      bodyOut.value = publishManualEdits.shorts.body ?? (kit.shorts.description || '');
    }
    if (commentWrap) commentWrap.hidden = false;
    if (commentOut && document.activeElement !== commentOut) {
      commentOut.value = publishManualEdits.shorts.comment ?? (kit.shorts.pinnedComment || '');
    }
    if (uploadLink) {
      uploadLink.href = kit.shorts.uploadUrl;
      uploadLink.textContent = '🔴 YouTube Studio 열기';
    }
    if (metaLink) metaLink.hidden = true;
  } else {
    if (tipEl) tipEl.textContent = `💡 ${kit.reels.tip}`;
    if (titleWrap) titleWrap.hidden = true;
    if (bodyLabel) bodyLabel.textContent = '릴스 캡션 · 프로필 품번 안내 · 해시태그 (직접 수정 가능)';
    if (bodyOut && document.activeElement !== bodyOut) {
      bodyOut.value = publishManualEdits.reels.body ?? (kit.reels.caption || '');
    }
    if (commentWrap) commentWrap.hidden = true;
    if (uploadLink) {
      uploadLink.href = kit.reels.uploadUrl;
      uploadLink.textContent = '🟣 인스타그램 열기';
    }
    if (metaLink) {
      metaLink.hidden = false;
      metaLink.href = kit.reels.metaSuiteUrl;
    }
  }
}

function renderPublishRemoteStatus() {
  const pr = appState?.publishRemote || {};
  const btn = $('multiUploadPrepareBtn');
  if (btn) {
    btn.disabled = Boolean(pr.busy);
    btn.textContent = pr.busy ? '⏳ 전용 Chrome 자동 입력 중…' : '🚀 선택 플랫폼 동시 자동 준비';
  }
  const targetLine = $('multiUploadTargetLine');
  if (targetLine) {
    const isExplicit = Boolean(previewOverride?.type === 'video' && previewOverride?.title && /\.mp4$/i.test(previewOverride.title));
    const curStyle = String(appState?.facts?.style || '').trim();
    const sameStyleLatest = curStyle
      ? (appState?.outputs || []).find(o => String(o?.filename || '').startsWith(`${curStyle}_`))
      : null;
    const defaultLatest = sameStyleLatest?.filename || appState?.render?.lastOutput?.filename || appState?.outputs?.[0]?.filename || '';
    const activeName = isExplicit ? previewOverride.title : defaultLatest;
    if (!activeName) {
      targetLine.hidden = true;
      targetLine.dataset.sig = '';
    } else {
      targetLine.hidden = false;
      const isSameAsLatest = activeName === defaultLatest;
      const targetSig = JSON.stringify([activeName, isExplicit, isSameAsLatest]);
      if (targetLine.dataset.sig !== targetSig) {
        targetLine.dataset.sig = targetSig;
        targetLine.innerHTML = isExplicit && !isSameAsLatest
          ? `<span>📎 선택 영상: <strong>${activeName}</strong></span><button type="button" class="mini-btn" id="resetUploadTargetBtn">최신본으로</button>`
          : `<span>📎 업로드 예정 (최신): <strong>${activeName}</strong></span>`;
        targetLine.querySelector('#resetUploadTargetBtn')?.addEventListener('click', () => {
          previewOverride = null;
          selectedAssetId = null;
          renderPreview();
          renderPublishRemoteStatus();
          showToast('최신 완성 영상으로 되돌렸습니다.');
        });
      }
    }
  }
  const box = $('publishRemoteResults');
  if (!box) return;
  const rows = Array.isArray(pr.results) ? pr.results : [];
  if (!pr.message && !rows.length) {
    box.hidden = true;
    box.dataset.sig = '';
    return;
  }
  box.hidden = false;
  const boxSig = JSON.stringify([pr.message || '', rows.map(r => [r.platform, r.status, r.message])]);
  if (box.dataset.sig === boxSig) return;
  box.dataset.sig = boxSig;
  const labelMap = {youtube: '🔴 쇼츠', clip: '🟢 클립', reels: '🟣 릴스'};
  const linesHtml = rows.map(r => {
    const cls = r.status === 'ready_for_review' ? 'ok' : (r.status === 'login_required' ? 'warn' : 'err');
    return `<div class="pub-rem-row ${cls}"><strong>${labelMap[r.platform] || r.platform}</strong> <span>${r.message}</span></div>`;
  }).join('');
  box.innerHTML = (pr.message ? `<div class="pub-rem-summary">${pr.message}</div>` : '') + linesHtml;
}

function renderStorageAndSync() {
  const storage = appState?.storage || {};
  const sync = appState?.sync || {};
  const autoCheck = $('autoSyncStorageCheck');
  if (autoCheck) {
    autoCheck.checked = storage.autoCopyDesktop !== false || storage.autoSyncGoogleDrive !== false;
  }
  const driveLink = $('openGoogleDriveLink');
  if (driveLink) {
    driveLink.href = storage.driveFolderUrl || 'https://drive.google.com/drive/my-drive';
    driveLink.title = `Google 드라이브 [${storage.driveFolderName || '지오다노_숏츠'}] 폴더 열기`;
  }
  if ($('driveFolderUrlInput') && document.activeElement !== $('driveFolderUrlInput')) {
    $('driveFolderUrlInput').value = storage.driveFolderUrl || '';
  }
  if ($('driveFolderNameInput') && document.activeElement !== $('driveFolderNameInput')) {
    $('driveFolderNameInput').value = storage.driveFolderName || '지오다노_숏츠';
  }
  if ($('desktopFolderNameInput') && document.activeElement !== $('desktopFolderNameInput')) {
    $('desktopFolderNameInput').value = storage.desktopFolderName || '숏츠완성영상';
  }
  const line = $('syncStatusLine');
  if (line) {
    if (sync.message) {
      line.hidden = false;
      line.className = 'sync-status-line ' + (sync.busy ? 'running' : (sync.status === 'completed' ? 'done' : (sync.status === 'error' || sync.status === 'login_required' ? 'error' : '')));
      line.textContent = sync.message;
    } else {
      line.hidden = true;
    }
  }
}

function renderProgressAndOutputs() {
  const {render, outputs, logs} = appState;
  $('renderStageText').textContent = render.stage || '대기 중';
  $('renderPercentText').textContent = `${render.progress || 0}%`;
  $('renderProgressFill').style.width = `${render.progress || 0}%`;
  $('renderBtn').disabled = Boolean(render.busy);
  if ($('renderPhotosOnlyBtn')) $('renderPhotosOnlyBtn').disabled = Boolean(render.busy);

  const errEl = $('renderErrorText');
  if (render.error) {
    errEl.hidden = false;
    errEl.textContent = render.error;
  } else {
    errEl.hidden = true;
  }

  $('outputCountLabel').textContent = `${outputs.length}편`;
  const listEl = $('outputsList');
  const outputsSig = JSON.stringify((outputs || []).map(o => [o.filename, o.url, o.sizeBytes]));
  if (listEl.dataset.sig !== outputsSig) {
    listEl.dataset.sig = outputsSig;
    if (!outputs.length) {
      listEl.innerHTML = `<p class="muted-line">아직 완성된 영상이 없습니다.</p>`;
    } else {
      listEl.innerHTML = '';
      for (const out of outputs) {
        const row = document.createElement('div');
        row.className = 'output-item';
        row.innerHTML = `
        <span class="output-name" title="${out.filename}">▶ ${out.filename}</span>
        <span class="output-right-meta">
          <span class="output-size">${(out.sizeBytes / (1024 * 1024)).toFixed(1)}MB</span>
        </span>
      `;
        row.addEventListener('click', () => {
          previewOverride = {type: 'video', url: out.url, title: out.filename};
          renderPreview();
          renderPublishRemoteStatus();
        });
        listEl.appendChild(row);
      }
    }
  }

  const logsEl = $('activityLogs');
  if (logsEl) {
    const topLogs = (logs || []).slice(0, 18);
    const logsSig = JSON.stringify(topLogs.map(l => [l.time, l.message]));
    if (logsEl.dataset.sig !== logsSig) {
      logsEl.dataset.sig = logsSig;
      logsEl.innerHTML = topLogs.map(l =>
        `<li><span class="log-time">${l.time}</span><span>${l.message}</span></li>`
      ).join('');
    }
  }
}


// === 상단 중앙 실시간 제작·완료 알림 팝업 & 완료 시 새 완성본 자동 표시 ===
let prevAnyWorkBusy = false;
let workStartedAtMs = 0;
let liveBannerHideTimer = null;
let lastCompletedFilename = '';

function showLiveBanner(mode, text, meta = '', autoHideMs = 0) {
  const el = $('liveWorkBanner');
  if (!el) return;
  if (liveBannerHideTimer) {
    clearTimeout(liveBannerHideTimer);
    liveBannerHideTimer = null;
  }
  const nextClass = 'live-work-banner ' + mode;
  if (el.className !== nextClass) el.className = nextClass;
  const icon = $('liveWorkIcon');
  const nextIcon = mode === 'done' ? '✓' : mode === 'error' ? '!' : '';
  if (icon && icon.textContent !== nextIcon) {
    icon.textContent = nextIcon;
  }
  const textEl = $('liveWorkText');
  if (textEl && textEl.textContent !== text) textEl.textContent = text;
  const metaEl = $('liveWorkMeta');
  if (metaEl && metaEl.textContent !== meta) metaEl.textContent = meta;
  if (el.hidden) el.hidden = false;
  if (autoHideMs > 0) {
    liveBannerHideTimer = setTimeout(() => {
      el.hidden = true;
      liveBannerHideTimer = null;
    }, autoHideMs);
  }
}

function syncLiveWorkBanner(state) {
  if (!state) return;
  const render = state.render || {};
  const flow = state.flow || {};
  const sync = state.sync || {};
  const pubRem = state.publishRemote || {};
  const nowBusy = Boolean(render.busy || flow.busy || sync.busy || pubRem.busy);
  const stopBtn = $('globalStopBtn');
  if (stopBtn) {
    stopBtn.classList.toggle('is-busy', nowBusy);
    stopBtn.textContent = nowBusy ? '🛑 작업 중단' : '🛑 중단';
  }
  const latestFile = render.lastOutput?.filename || '';

  if (nowBusy) {
    if (!prevAnyWorkBusy) {
      workStartedAtMs = Date.now();
    }
    const elapsedSec = Math.max(1, Math.round((Date.now() - (workStartedAtMs || Date.now())) / 1000));
    if (render.busy) {
      showLiveBanner('running', `숏츠 제작 중 · ${render.stage || '렌더링 진행 중…'}`, `${render.progress || 0}% · ${elapsedSec}초`);
    } else if (flow.busy) {
      showLiveBanner('running', `Flow 자동 제작 중 · ${flow.message || '진행 중…'}`, `${elapsedSec}초 경과`);
    } else if (sync.busy) {
      showLiveBanner('running', sync.message || '☁ Google 드라이브 자동 업로드 중…', `${elapsedSec}초 경과`);
    } else if (pubRem.busy) {
      showLiveBanner('running', pubRem.message || '🚀 플랫폼 동시 자동 업로드 준비 중…', `${elapsedSec}초 경과`);
    }
  } else if (prevAnyWorkBusy) {
    // 진행 중 -> 종료 전환 시 최초 1회만 완료/오류 알림 표시 (반복 폴링으로 되살리지 않음)
    if (render.error || flow.status === 'error') {
      showLiveBanner('error', `작업 오류 · ${render.error || flow.message || '확인이 필요합니다.'}`, '', 5200);
    } else if (flow.status === 'login_required') {
      showLiveBanner('error', '전용 Chrome 창에서 Google 로그인을 완료해 주세요.', '', 5200);
    } else if (flow.status === 'cancelled') {
      showLiveBanner('error', '자동 제작이 중지되었습니다.', '', 4000);
    } else {
      // 새 완성본 자동 표시
      if (latestFile && latestFile !== lastCompletedFilename) {
        selectedAssetId = null;
        previewOverride = null;
        lastCompletedFilename = latestFile;
      }
      const doneText = (pubRem.status === 'completed' && pubRem.message && !latestFile)
        ? pubRem.message
        : (sync.status === 'completed' && sync.message)
        ? sync.message
        : (sync.status === 'error' || sync.status === 'login_required')
          ? (sync.message || '제작 완료 (드라이브 업로드 확인 필요)')
          : '제작 완료! 완성 필름을 바로 불러왔습니다.';
      const doneMode = (sync.status === 'error' || sync.status === 'login_required') ? 'error' : 'done';
      showLiveBanner(doneMode, doneText, latestFile ? '100%' : '', 4800);
    }
    workStartedAtMs = 0;
  } else {
    if (latestFile && !lastCompletedFilename) {
      lastCompletedFilename = latestFile;
    }
    // 안전장치: 현재 진행 중인 작업이 없는데 running 배너가 남아 있으면 즉시 정리
    const el = $('liveWorkBanner');
    if (el && !el.hidden && el.classList.contains('running')) {
      el.hidden = true;
    }
  }

  prevAnyWorkBusy = nowBusy;
}

function renderReleaseInfo(release) {
  const pill = $('appVersionPill');
  const updated = $('appVersionUpdated');
  if (!release) return;
  if (pill) {
    const label = release.needsRestart
      ? `버전 ${release.bootVersion} (↻ 재시작 → ${release.version})`
      : `버전 ${release.version}`;
    if (pill.textContent !== label) pill.textContent = label;
    pill.classList.toggle('outdated', Boolean(release.needsRestart));
    const tip = release.needsRestart
      ? `새 버전(${release.version})이 반영되었습니다. 바탕화면 [숏츠등록기 최신버전]을 다시 실행해 주세요.`
      : `현재 버전 ${release.version}${release.commit ? ` (${release.commit})` : ''} · 최종 수정 ${release.displayDate || ''}`;
    if (pill.title !== tip) pill.title = tip;
  }
  if (updated) {
    const dateLabel = release.displayDate ? `최종 수정: ${release.displayDate}` : '';
    if (updated.textContent !== dateLabel) updated.textContent = dateLabel;
    if (release.updatedAt) updated.dateTime = release.updatedAt;
  }
}

function renderAll() {
  syncLiveWorkBanner(appState);
  if (!appState) return;
  renderReleaseInfo(appState.release);
  renderEnv(appState.env);
  renderRecentStyles(appState.recentStyles);
  renderFilmStrip(appState.assets);
  renderFactsAndOptions();
  renderStorageAndSync();
  renderPublishKit();
  renderPublishRemoteStatus();
  renderPlatformLoginStatus();
  renderProgressAndOutputs();
  renderPreview();
}

let pollInFlight = false;

function shouldKeepPolling(state) {
  return Boolean(
    state?.render?.busy ||
    state?.flow?.busy ||
    state?.flow?.watchingDownloads ||
    state?.sync?.busy ||
    state?.publishRemote?.busy
  );
}

function ensurePolling() {
  if (!shouldKeepPolling(appState) || pollTimer) return;
  pollTimer = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const prevRenderBusy = Boolean(appState?.render?.busy);
      appState = await api('/api/state');
      const nowRenderBusy = Boolean(appState?.render?.busy);
      const keepPolling = shouldKeepPolling(appState);
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
    finally {
      pollInFlight = false;
    }
  }, 1500);
}

async function refreshState() {
  appState = await api('/api/state');
  renderAll();
  ensurePolling();
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
    const loadedStyle = String(appState?.facts?.style || appState?.product?.style || val).trim();
    if ($('styleInput') && loadedStyle) {
      $('styleInput').value = loadedStyle;
      lastSyncedStyleInput = loadedStyle;
    }
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
            hookText: $('factHookText') ? $('factHookText').value : '',
            productUrl: $('factProductUrlInput') ? $('factProductUrlInput').value : '',
            sellingPoints,
            showLogo: $('showLogoCheck').checked,
            showPrice: $('showPriceCheck').checked,
            showColors: $('showColorsCheck').checked,
          },
          options: {
            frameLayout: $('frameLayoutSelect')?.value || 'white-studio',
            captionStyle: $('captionStyleSelect')?.value || 'reels-highlight',
            captionPosition: $('captionPositionSelect')?.value || 'safe-lower',
            transitionStyle: $('transitionStyleSelect')?.value || 'fade',
            builtinBgm: $('builtinBgmSelect')?.value ?? 'lounge-pad',
            includeSplitShowcase: $('includeSplitShowcaseCheck') ? $('includeSplitShowcaseCheck').checked : true,
            videoSpeed: Number($('videoSpeedSelect')?.value || 1.2),
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
$('openDesktopOutputsBtn')?.addEventListener('click', () => api('/api/open-folder', {method: 'POST', body: JSON.stringify({target: 'desktop-outputs'})}));

let storageSaveTimer = null;
function scheduleSaveStorageSettings() {
  clearTimeout(storageSaveTimer);
  storageSaveTimer = setTimeout(async () => {
    try {
      const enabled = $('autoSyncStorageCheck') ? $('autoSyncStorageCheck').checked : true;
      appState = await api('/api/storage/settings', {
        method: 'POST',
        body: JSON.stringify({
          autoCopyDesktop: enabled,
          autoSyncGoogleDrive: enabled,
          driveFolderUrl: $('driveFolderUrlInput')?.value ?? undefined,
          driveFolderName: $('driveFolderNameInput')?.value ?? undefined,
          desktopFolderName: $('desktopFolderNameInput')?.value ?? undefined,
        }),
      });
      renderStorageAndSync();
    } catch {}
  }, 260);
}

$('autoSyncStorageCheck')?.addEventListener('change', () => {
  scheduleSaveStorageSettings();
  showToast($('autoSyncStorageCheck').checked
    ? '💾 바탕화면 + ☁ Google 드라이브 자동 동시 저장을 켰습니다.'
    : '자동 동시 저장을 껐습니다. (필요 시 목록의 ☁ 버튼으로 개별 전송 가능)');
});
['driveFolderUrlInput', 'driveFolderNameInput', 'desktopFolderNameInput'].forEach(id => {
  $(id)?.addEventListener('change', scheduleSaveStorageSettings);
});

$('flowRemoteAutoBtn')?.addEventListener('click', async () => {
  showLiveBanner('running', '원클릭 Flow 자동 제작을 시작합니다…', '연결 중');
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
        frameLayout: $('frameLayoutSelect')?.value || 'white-studio',
      }),
    });
    renderAll();
    ensurePolling();
    showToast('⚡ 원클릭 Flow 끝까지 자동화를 시작했습니다! 전용 Chrome 창에서 진행 상황을 확인하세요.');
  } catch (err) {
    renderAll();
    showLiveBanner('error', `Flow 자동 제작 오류 · ${err.message}`, '', 4500);
    showToast(err.message);
  }
});

$('flowRemoteOpenBtn')?.addEventListener('click', async () => {
  try {
    appState = await api('/api/flow/remote-open', {method: 'POST'});
    renderAll();
    showToast('🌐 전용 Flow Chrome 창을 열었습니다. 최초 1회 Google 로그인 후 원클릭 자동화를 눌러주세요!');
  } catch (err) {
    showToast(err.message);
  }
});

$('flowRemoteCancelBtn')?.addEventListener('click', async () => {
  try {
    appState = await api('/api/flow/remote-cancel', {method: 'POST'});
    renderAll();
    showToast('Flow 자동 실행 중지를 요청했습니다.');
  } catch (err) {
    showToast(err.message);
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
        frameLayout: $('frameLayoutSelect')?.value || 'white-studio',
      }),
    });
    renderAll();
    ensurePolling();
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

async function triggerRender(photosOnly = false) {
  if ($('renderBtn')) $('renderBtn').disabled = true;
  if ($('renderPhotosOnlyBtn')) $('renderPhotosOnlyBtn').disabled = true;
  showLiveBanner('running', photosOnly ? '사진만으로 숏츠 제작을 시작합니다…' : '최종 숏츠 제작을 시작합니다…', '준비 중');
  try {
    await api('/api/facts/update', {
      method: 'POST',
      body: JSON.stringify({
        facts: {
          style: $('factStyle').value,
          price: $('factPrice').value,
          material: $('factMaterial').value,
          headline: $('factHeadline').value,
          hookText: $('factHookText') ? $('factHookText').value : '',
          sellingPoints: $('factPoints').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5),
          showLogo: $('showLogoCheck').checked,
          showPrice: $('showPriceCheck').checked,
          showColors: $('showColorsCheck').checked,
        },
        options: {
          frameLayout: $('frameLayoutSelect')?.value || 'white-studio',
          captionStyle: $('captionStyleSelect')?.value || 'reels-highlight',
            captionPosition: $('captionPositionSelect')?.value || 'safe-lower',
          transitionStyle: $('transitionStyleSelect')?.value || 'fade',
          builtinBgm: $('builtinBgmSelect')?.value ?? 'lounge-pad',
          includeSplitShowcase: $('includeSplitShowcaseCheck') ? $('includeSplitShowcaseCheck').checked : true,
          videoSpeed: Number($('videoSpeedSelect')?.value || 1.2),
            targetDurationSec: Number($('targetDurationInput').value || 17.5),
          bgmVolume: Number($('bgmVolumeInput').value || 0.35),
          originalVolume: Number($('origVolumeInput').value || 0.8),
          keepOriginalAudio: $('keepOriginalAudioCheck').checked,
          includeEnding: $('includeEndingCheck').checked,
        },
      }),
    });
    appState = await api('/api/render', {method: 'POST', body: JSON.stringify({photosOnly})});
    renderAll();
    ensurePolling();
  } catch (err) {
    renderAll();
    showLiveBanner('error', `제작 오류 · ${err.message}`, '', 4500);
    showToast(err.message);
  }
}

$('renderBtn').addEventListener('click', () => triggerRender(false));
$('renderPhotosOnlyBtn')?.addEventListener('click', () => triggerRender(true));

$('refreshPageBtn')?.addEventListener('click', () => {
  window.location.reload();
});

$('globalStopBtn')?.addEventListener('click', async () => {
  const btn = $('globalStopBtn');
  try {
    if (btn) btn.disabled = true;
    appState = await api('/api/stop-all', {method: 'POST'});
    renderAll();
    showLiveBanner('error', '🛑 진행 중인 작업을 중단했습니다.', '', 3600);
    showToast('🛑 진행 중인 모든 작업을 중단했습니다.');
  } catch (err) {
    showToast('중단 요청 오류: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('resetBtn').addEventListener('click', async () => {
  try {
    appState = await api('/api/reset', {method: 'POST'});
    selectedAssetId = null;
    previewOverride = null;
    $('styleInput').value = '';
    lastSyncedStyleInput = '';
    renderAll();
    showToast('새 작업실을 열었습니다.');
  } catch (err) {
    showToast(err.message);
  }
});

document.documentElement.setAttribute('data-theme', 'light');
try { localStorage.removeItem('atelier-theme'); } catch {}

[
  'factStyle', 'factPrice', 'factMaterial', 'factHeadline', 'factHookText', 'factPoints',
  'frameLayoutSelect', 'captionStyleSelect', 'captionPositionSelect', 'transitionStyleSelect', 'builtinBgmSelect', 'includeSplitShowcaseCheck',
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


function syncFrameThemeCards(frameKey) {
  const key = ['white-studio', 'letterbox-black', 'top-header-full', 'fullscreen'].includes(frameKey) ? frameKey : 'white-studio';
  if ($('frameWhiteBtn')) $('frameWhiteBtn').classList.toggle('active', key === 'white-studio');
  if ($('frameBlackBtn')) $('frameBlackBtn').classList.toggle('active', key === 'letterbox-black');
  const pill = $('frameSavedPill');
  if (pill) {
    const labels = {
      'white-studio': '✓ 화이트 버전 저장됨 (전 영상 적용)',
      'letterbox-black': '✓ 블랙 버전 저장됨 (전 영상 적용)',
      'top-header-full': '✓ 상단 블랙 확장 저장됨 (전 영상 적용)',
      'fullscreen': '✓ 9:16 풀화면 저장됨 (전 영상 적용)',
    };
    pill.textContent = labels[key] || labels['white-studio'];
  }
}

async function selectFrameThemeImmediate(frameKey) {
  const key = ['white-studio', 'letterbox-black', 'top-header-full', 'fullscreen'].includes(frameKey) ? frameKey : 'white-studio';
  if ($('frameLayoutSelect')) $('frameLayoutSelect').value = key;
  syncFrameThemeCards(key);
  try {
    appState = await api('/api/facts/update', {
      method: 'POST',
      body: JSON.stringify({options: {frameLayout: key}}),
    });
    renderFactsAndOptions();
    const label = key === 'white-studio' ? '🤍 화이트 버전' : key === 'letterbox-black' ? '🖤 블랙 버전' : key;
    showToast(`${label}으로 영구 저장되었습니다! 앞으로 모든 영상에 자동 적용됩니다.`);
  } catch (err) {
    showToast(err.message);
  }
}

$('frameWhiteBtn')?.addEventListener('click', () => selectFrameThemeImmediate('white-studio'));
$('frameBlackBtn')?.addEventListener('click', () => selectFrameThemeImmediate('letterbox-black'));

// === WIRING_COMPLETE_ALL_FEATURE_BUTTONS ===
// 1) 배경 음악 미리듣기 · 내 MP3 보관함 추가 · 바탕화면 숏츠BGM 폴더 열기
$('openBgmFolderBtn')?.addEventListener('click', () => {
  api('/api/open-folder', {method: 'POST', body: JSON.stringify({target: 'bgm-library'})}).catch(err => showToast(err.message));
});
$('previewBgmBtn')?.addEventListener('click', () => toggleBgmPreview());
$('builtinBgmSelect')?.addEventListener('change', () => {
  if (bgmPreviewAudio && !bgmPreviewAudio.paused) {
    const val = $('builtinBgmSelect').value;
    if (val === 'none') stopBgmPreview();
    else toggleBgmPreview(val);
  }
});
$('addLibraryBgmBtn')?.addEventListener('click', () => $('libraryBgmFileInput')?.click());
$('libraryBgmFileInput')?.addEventListener('change', async () => {
  const input = $('libraryBgmFileInput');
  const file = input?.files?.[0];
  if (!file) return;
  try {
    showToast(`내 음악 보관함에 저장 중: ${file.name}`);
    appState = await api(`/api/bgm/library-upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    });
    renderAll();
    showToast(`💿 [${file.name}] 보관함 추가 및 선택 완료! (바탕화면 숏츠BGM 폴더에 저장됨)`);
  } catch (err) {
    showToast(err.message);
  } finally {
    input.value = '';
  }
});

// 2) 첫 3초 후킹 멘트 10개 추천 열기/닫기 & 비우기
$('toggleHookPickerBtn')?.addEventListener('click', () => {
  const box = $('hookCandidatesBox');
  const btn = $('toggleHookPickerBtn');
  if (!box) return;
  box.hidden = !box.hidden;
  if (btn) btn.textContent = box.hidden ? '✨ 10개 추천' : '▲ 추천 닫기';
});
$('clearHookBtn')?.addEventListener('click', () => {
  if ($('factHookText')) $('factHookText').value = '';
  scheduleSaveFactsAndOptions();
  showToast('후킹 멘트를 비웠습니다. (영상 첫 자막은 기본 상품명으로 시작합니다)');
});

// 3) 트렌드 저격 처방 보기 & 6종 원클릭 자동 세팅
$('toggleTrendDetailBtn')?.addEventListener('click', () => {
  const body = $('trendDetailBody');
  const btn = $('toggleTrendDetailBtn');
  if (!body) return;
  body.hidden = !body.hidden;
  if (btn) btn.textContent = body.hidden ? '처방 보기' : '접기';
});
$('applyTrendBtn')?.addEventListener('click', async () => {
  try {
    appState = await api('/api/trend/apply', {method: 'POST'});
    renderAll();
    showToast('⚡ 트렌드 저격 6종(연출·자막·위치·배속·전환·BGM)이 한 번에 적용되었습니다!');
  } catch (err) {
    showToast(err.message);
  }
});

function shortenProductUrlClient(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!['http:', 'https:'].includes(u.protocol)) return s;
    const host = u.hostname.toLowerCase();
    const isNaverCanonical =
      (host === 'shopping.naver.com' && /^\/(?:window-products\/[^/]+\/\d+|window\/[^/]+\/store\/\d+)/i.test(u.pathname)) ||
      ((host === 'smartstore.naver.com' || host === 'm.smartstore.naver.com' || host === 'brand.naver.com') &&
        /^\/[^/]+\/products\/\d+/i.test(u.pathname));
    if (isNaverCanonical) {
      u.search = '';
      u.hash = '';
      u.pathname = u.pathname.replace(/\/+$/, '');
      return u.href;
    }
    for (const key of [...u.searchParams.keys()]) {
      const low = key.toLowerCase();
      if (['napm', 'fbclid', 'igshid', 'gclid', 'ref', 'from', 'tr', 'ci', 'ct', 'hk', 'nv_ad'].includes(low) || low.startsWith('utm_') || low.startsWith('nt_')) {
        u.searchParams.delete(key);
      }
    }
    return u.href;
  } catch {
    return s;
  }
}

// 4) 개별 상품 구매 URL 원클릭 붙여넣기 · 비우기 · 통합 스토어 주소 저장
async function saveProductUrlImmediate(rawVal, toastMsg) {
  const input = $('factProductUrlInput');
  const rawStr = String(rawVal ?? input?.value ?? '').trim();
  if (rawStr && !/^https?:\/\//i.test(rawStr)) {
    return showToast('https:// 로 시작하는 상품 주소를 붙여넣어 주세요.');
  }
  const trimmed = rawStr ? shortenProductUrlClient(rawStr) : '';
  if (input) input.value = trimmed;
  try {
    appState = await api('/api/facts/update', {
      method: 'POST',
      body: JSON.stringify({facts: {productUrl: trimmed}}),
    });
    renderPublishKit();
    showToast(toastMsg || (trimmed ? '🔗 불필요한 추적 꼬리표를 제거하고 짧은 정식 URL로 저장했습니다!' : '개별 URL을 비웠습니다 (통합 스토어 주소 사용)'));
  } catch (err) {
    showToast(err.message);
  }
}

$('factProductUrlInput')?.addEventListener('change', () => saveProductUrlImmediate());
$('factProductUrlInput')?.addEventListener('paste', () => {
  setTimeout(() => saveProductUrlImmediate(), 40);
});
$('pasteProductUrlBtn')?.addEventListener('click', async () => {
  try {
    const clipText = (await navigator.clipboard.readText()).trim();
    if (!clipText) return showToast('클립보드가 비어 있습니다. 상품 주소를 먼저 복사(Ctrl+C)해 주세요.');
    await saveProductUrlImmediate(clipText, '📋 개별 상품 URL 붙여넣기 & 품번별 저장 완료!');
  } catch {
    $('factProductUrlInput')?.focus();
    showToast('입력칸을 누르고 Ctrl+V로 붙여넣어 주세요.');
  }
});
$('clearProductUrlBtn')?.addEventListener('click', () => {
  saveProductUrlImmediate('', '개별 URL을 비웠습니다. (통합 스토어 주소를 사용합니다)');
});
$('publishStoreUrlInput')?.addEventListener('change', async () => {
  try {
    appState = await api('/api/publish/settings', {
      method: 'POST',
      body: JSON.stringify({storeUrl: $('publishStoreUrlInput').value}),
    });
    renderPublishKit();
    showToast('🔗 내 스토어 기본 URL이 저장되었습니다.');
  } catch (err) {
    showToast(err.message);
  }
});

// 5) 클립 · 쇼츠 · 릴스 탭 전환 · 본문 직접 수정 보존 · 복사 · 다시 생성
document.querySelectorAll('#publishPlatformTabs button[data-platform]').forEach(btn => {
  btn.addEventListener('click', () => {
    activePublishPlatform = btn.dataset.platform || 'clip';
    renderPublishKit();
  });
});
$('copyPublishTitleBtn')?.addEventListener('click', () => copyTextSafe($('publishTitleOut')?.value, '제목'));
$('copyPublishBodyBtn')?.addEventListener('click', () => copyTextSafe($('publishBodyOut')?.value, '본문·URL·해시태그'));
$('copyPublishCommentBtn')?.addEventListener('click', () => copyTextSafe($('publishCommentOut')?.value, '고정 댓글'));
$('publishTitleOut')?.addEventListener('input', () => {
  if (activePublishPlatform === 'clip') publishManualEdits.clip.title = $('publishTitleOut').value;
  else if (activePublishPlatform === 'shorts') publishManualEdits.shorts.title = $('publishTitleOut').value;
});
$('publishBodyOut')?.addEventListener('input', () => {
  if (activePublishPlatform === 'clip') publishManualEdits.clip.body = $('publishBodyOut').value;
  else if (activePublishPlatform === 'shorts') publishManualEdits.shorts.body = $('publishBodyOut').value;
  else publishManualEdits.reels.body = $('publishBodyOut').value;
});
$('publishCommentOut')?.addEventListener('input', () => {
  if (activePublishPlatform === 'shorts') publishManualEdits.shorts.comment = $('publishCommentOut').value;
});
$('resetPublishTextBtn')?.addEventListener('click', () => {
  resetPublishManualEdits(publishEditsStyleKey);
  renderPublishKit();
  showToast('↻ 현재 품번 기준으로 자동 문구와 해시태그를 다시 생성했습니다.');
});

// 6) 전용 Chrome 3대 플랫폼 로그인 창 열기 & 동시 자동 업로드 준비
$('multiUploadLoginBtn')?.addEventListener('click', async () => {
  const btn = $('multiUploadLoginBtn');
  try {
    const platforms = [];
    if ($('chkUploadClip')?.checked) platforms.push('clip');
    if ($('chkUploadYoutube')?.checked) platforms.push('youtube');
    if ($('chkUploadReels')?.checked) platforms.push('reels');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ 여는 중…';
    }
    showToast('🔑 전용 Chrome에 로그인 창을 여는 중입니다…');
    appState = await api('/api/publish/open-logins', {
      method: 'POST',
      body: JSON.stringify({platforms: platforms.length ? platforms : ['clip', 'youtube', 'reels']}),
    });
    renderAll();
    showToast('🔑 전용 Chrome에 로그인 창을 열었습니다! 로그인 후 동시 자동 준비를 눌러주세요.');
  } catch (err) {
    showToast('로그인 창 열기 오류: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔑 로그인';
    }
  }
});

$('multiUploadPrepareBtn')?.addEventListener('click', async () => {
  const platforms = [];
  if ($('chkUploadClip')?.checked) platforms.push('clip');
  if ($('chkUploadYoutube')?.checked) platforms.push('youtube');
  if ($('chkUploadReels')?.checked) platforms.push('reels');
  if (!platforms.length) return showToast('자동 준비할 플랫폼(클립·쇼츠·릴스)을 1개 이상 체크해 주세요.');

  const kit = appState?.publishKit || {};
  const clipPayload = {
    title: publishManualEdits.clip.title ?? kit.clip?.title ?? '',
    body: publishManualEdits.clip.body ?? kit.clip?.body ?? '',
  };
  const shortsPayload = {
    title: publishManualEdits.shorts.title ?? kit.shorts?.title ?? '',
    description: publishManualEdits.shorts.body ?? kit.shorts?.description ?? '',
    pinnedComment: publishManualEdits.shorts.comment ?? kit.shorts?.pinnedComment ?? '',
  };
  const reelsPayload = {
    caption: publishManualEdits.reels.body ?? kit.reels?.caption ?? '',
  };
  const isExplicitPreview = Boolean(previewOverride?.type === 'video' && previewOverride?.title && /\.mp4$/i.test(previewOverride.title));
  const targetFilename = isExplicitPreview ? previewOverride.title : '';

  showLiveBanner('running', '🚀 전용 Chrome에서 선택한 플랫폼 업로드 화면을 자동 준비합니다…', '연결 중');
  try {
    appState = await api('/api/publish/remote-prepare', {
      method: 'POST',
      body: JSON.stringify({
        platforms,
        filename: targetFilename,
        explicitPreview: isExplicitPreview,
        clip: clipPayload,
        shorts: shortsPayload,
        reels: reelsPayload,
      }),
    });
    renderAll();
    ensurePolling();
  } catch (err) {
    renderAll();
    showLiveBanner('error', `동시 업로드 준비 오류 · ${err.message}`, '', 4500);
    showToast(err.message);
  }
});

// 7) 플랫폼 로그인 정보 암호화 저장 모달 (이 PC data/ 전용)
function renderPlatformLoginStatus() {
  const accounts = appState?.platformLogins?.accounts || {};
  const keys = ['clip', 'reels'];
  let savedCount = 0;
  for (const key of keys) {
    const info = accounts[key] || {};
    if (info.configured && info.enabled) savedCount += 1;
    const badge = $(`loginBadge-${key}`);
    if (badge) {
      if (info.configured && info.enabled) {
        badge.textContent = `저장됨 (${info.accountHint || '계정'})`;
        badge.className = 'login-status-pill saved';
      } else if (info.configured) {
        badge.textContent = `꺼짐 (${info.accountHint || '계정'})`;
        badge.className = 'login-status-pill paused';
      } else {
        badge.textContent = '미저장';
        badge.className = 'login-status-pill';
      }
    }
    const delBtn = $(`loginDelete-${key}`);
    if (delBtn) delBtn.hidden = !info.configured;
    const chk = $(`loginEnabled-${key}`);
    if (chk && document.activeElement !== chk) {
      chk.checked = info.configured ? Boolean(info.enabled) : true;
    }
  }
  const headerBtn = $('headerLoginConfigBtn');
  if (headerBtn) {
    headerBtn.classList.toggle('has-saved', savedCount > 0);
    headerBtn.textContent = savedCount > 0 ? `🔐 로그인 저장 (${savedCount})` : '🔐 로그인 저장';
  }
  const cardBtn = $('platformLoginConfigBtn');
  if (cardBtn) {
    cardBtn.classList.toggle('active', savedCount > 0);
    cardBtn.textContent = savedCount > 0 ? `🔐 저장 (${savedCount})` : '🔐 저장';
  }
}

function openPlatformLoginModal() {
  renderPlatformLoginStatus();
  const modal = $('platformLoginModal');
  if (modal) modal.hidden = false;
}

function closePlatformLoginModal() {
  const modal = $('platformLoginModal');
  if (modal) modal.hidden = true;
}

$('headerLoginConfigBtn')?.addEventListener('click', openPlatformLoginModal);
$('platformLoginConfigBtn')?.addEventListener('click', openPlatformLoginModal);
$('closePlatformLoginBtn')?.addEventListener('click', closePlatformLoginModal);
$('platformLoginBackdrop')?.addEventListener('click', closePlatformLoginModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('platformLoginModal') && !$('platformLoginModal').hidden) {
    closePlatformLoginModal();
  }
});

['clip', 'reels'].forEach(platform => {
  const labelMap = {clip: '네이버 클립', reels: '인스타그램'};
  const saveBtn = document.querySelector(`[data-login-save="${platform}"]`);
  const delBtn = document.querySelector(`[data-login-delete="${platform}"]`);
  const chk = $(`loginEnabled-${platform}`);

  saveBtn?.addEventListener('click', async () => {
    const userEl = $(`loginUser-${platform}`);
    const passEl = $(`loginPass-${platform}`);
    const username = String(userEl?.value || '').trim();
    const password = String(passEl?.value || '');
    const enabled = chk ? chk.checked : true;
    try {
      saveBtn.disabled = true;
      appState = await api('/api/publish/login-settings', {
        method: 'POST',
        body: JSON.stringify({platform, action: 'save', username, password, enabled}),
      });
      if (userEl && username) userEl.value = '';
      if (passEl) passEl.value = '';
      renderPlatformLoginStatus();
      showToast(`🔐 ${labelMap[platform]} 로그인 정보가 이 PC에 암호화 저장되었습니다!`);
    } catch (err) {
      showToast(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  delBtn?.addEventListener('click', async () => {
    try {
      delBtn.disabled = true;
      appState = await api('/api/publish/login-settings', {
        method: 'POST',
        body: JSON.stringify({platform, action: 'delete'}),
      });
      if ($(`loginUser-${platform}`)) $(`loginUser-${platform}`).value = '';
      if ($(`loginPass-${platform}`)) $(`loginPass-${platform}`).value = '';
      renderPlatformLoginStatus();
      showToast(`🔐 ${labelMap[platform]} 저장된 로그인 정보를 삭제했습니다.`);
    } catch (err) {
      showToast(err.message);
    } finally {
      delBtn.disabled = false;
    }
  });

  chk?.addEventListener('change', async () => {
    const info = appState?.platformLogins?.accounts?.[platform];
    if (!info?.configured) return;
    try {
      appState = await api('/api/publish/login-settings', {
        method: 'POST',
        body: JSON.stringify({platform, action: 'save', enabled: chk.checked}),
      });
      renderPlatformLoginStatus();
      showToast(`${labelMap[platform]} 자동 로그인 ${chk.checked ? '켜짐' : '꺼짐'}`);
    } catch (err) {
      showToast(err.message);
    }
  });
});
