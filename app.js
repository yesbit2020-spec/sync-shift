// sync-shift アプリケーションコアロジック
// - スマホ最適化: 左右スワイプ週移動
// - スマホ最適化: 上下スクロールとドラッグ選択のスマート分離（長押し/縦移動判定）
// - スマホ最適化: モーダルからの安心削除機能

// === 認証設定 ===
const CLIENT_ID = '107057563168-ocp8fupandai0hima45lpvl1ut070crk.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

let tokenClient = null;
let accessToken = null;

// === カレンダー設定 ===
const START_HOUR = 9; // 9:00 開始に最適化
const END_HOUR = 24; // 9:00 〜 24:00 (15時間)
const SLOT_MINUTES = 30; // 30分単位
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR;

function getActualCellHeight() {
  const sampleCell = document.querySelector('.slot-cell');
  if (sampleCell && sampleCell.offsetHeight > 0) {
    return sampleCell.offsetHeight;
  }
  return 40;
}

let currentWeekOffset = 0; // 0 = 今週
let isDragging = false;
let dragStart = null;
let dragCurrent = null;

// タッチ操作判定用ステート
let touchOriginX = 0;
let touchOriginY = 0;
let isTouchSelectionActive = false;
let touchHoldTimer = null;

// 複数選択キュー
let pendingSchedules = [];
let calendarEvents = [];

// カレンダーリストストア
let allCalendars = []; // [{ id, summary, primary, backgroundColor, colorId }, ...]
let selectedCalendarIds = []; // 表示対象として選択されたカレンダーIDの配列

let autoScrollTimer = null;
let lastPointerClientY = 0;
let editingTarget = null; // { mode: 'create' | 'edit' | 'committed', data: ... }

// DOM要素
const calendarContainer = document.getElementById('calendarContainer');
const gridHeader = document.getElementById('gridHeader');
const gridBody = document.getElementById('gridBody');
const timeLabels = document.getElementById('timeLabels');
const weekRangeLabel = document.getElementById('weekRangeLabel');
const prevWeekBtn = document.getElementById('prevWeekBtn');
const nextWeekBtn = document.getElementById('nextWeekBtn');
const calFilterBtn = document.getElementById('calFilterBtn');
const calCountBadge = document.getElementById('calCountBadge');
const calDropdownPanel = document.getElementById('calDropdownPanel');
const calCheckboxList = document.getElementById('calCheckboxList');
const submitBtn = document.getElementById('submitBtn');
const clearBtn = document.getElementById('clearBtn');
const selectionInfo = document.getElementById('selectionInfo');
const toast = document.getElementById('toast');
const authBtn = document.getElementById('authBtn');
const authBtnText = document.getElementById('authBtnText');
const reloadBtn = document.getElementById('reloadBtn');

// モーダルDOM要素
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalTimeRange = document.getElementById('modalTimeRange');
const eventCalSelect = document.getElementById('eventCalSelect');
const eventTitleInput = document.getElementById('eventTitleInput');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');
const modalDeleteBtn = document.getElementById('modalDeleteBtn');
const modalCopyBtn = document.getElementById('modalCopyBtn');

// ==========================================
// Google Identity Services (GIS) 認証処理 & 自動再接続（永続化強化版）
// ==========================================
function initGoogleAuth() {
  // まず即座にローカルキャッシュから復元（SDKの読み込みを待たない）
  restoreLocalSession();

  if (typeof google === 'undefined') {
    setTimeout(initGoogleAuth, 300);
    return;
  }

  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: async (tokenResponse) => {
        if (tokenResponse.error !== undefined) {
          console.warn('Google Auth callback error:', tokenResponse.error);
          // サイレント更新が弾かれた場合でも、保存データを勝手に破棄しない
          return;
        }
        accessToken = tokenResponse.access_token;
        
        const expiresInMs = (tokenResponse.expires_in || 3600) * 1000;
        const expireTime = Date.now() + expiresInMs;
        localStorage.setItem('syncshift_token', accessToken);
        localStorage.setItem('syncshift_expire', expireTime.toString());

        // ユーザーのメアドを取得して保存
        await fetchUserEmailAndSave();

        setConnectedUI();
        showToast('⚡ Googleカレンダーと同期完了！');
        
        await loadCalendarList();
        await loadCalendarEvents();
      },
    });

    // SDK初期化完了後のチェック
    checkAutoLogin();
  } catch (err) {
    console.error('Failed to init tokenClient', err);
  }
}

// 起動直後にローカルデータを復元する（0ミリ秒復元）
function restoreLocalSession() {
  const savedToken = localStorage.getItem('syncshift_token');
  const savedEmail = localStorage.getItem('syncshift_email');
  const savedCals = localStorage.getItem('syncshift_cached_cals');
  const savedEvents = localStorage.getItem('syncshift_cached_events');

  if (savedEmail || savedToken) {
    if (savedToken) accessToken = savedToken;
    setConnectedUI();
  }

  if (savedCals) {
    try {
      allCalendars = JSON.parse(savedCals);
      const savedSelected = JSON.parse(localStorage.getItem('syncshift_selected_cals') || '[]');
      if (savedSelected.length > 0) {
        selectedCalendarIds = savedSelected.filter(id => allCalendars.some(c => c.id === id));
      }
      if (selectedCalendarIds.length === 0 && allCalendars.length > 0) {
        const primaryCal = allCalendars.find(c => c.primary);
        selectedCalendarIds = primaryCal ? [primaryCal.id] : [allCalendars[0].id];
      }
      renderCalDropdown();
      updateCalFilterUI();
    } catch (e) {
      console.warn('Failed to parse cached cals', e);
    }
  }

  // 以前取得した予定データがあれば即座に表示（画面が空っぽになるのを完全防止）
  if (savedEvents) {
    try {
      calendarEvents = JSON.parse(savedEvents);
      renderWeek();
    } catch (e) {
      console.warn('Failed to parse cached events', e);
    }
  }
}

async function fetchUserEmailAndSave() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.id) {
        localStorage.setItem('syncshift_email', data.id);
        setConnectedUI();
      }
    }
  } catch (e) {
    console.warn('Could not fetch user email', e);
  }
}

function setConnectedUI() {
  authBtn.classList.add('connected');
  const savedEmail = localStorage.getItem('syncshift_email');
  if (savedEmail) {
    const prefix = savedEmail.split('@')[0];
    const shortEmail = prefix.length > 10 ? prefix.substring(0, 8) + '...' : prefix;
    authBtnText.textContent = `${shortEmail} ✓`;
  } else {
    authBtnText.textContent = 'Google連携中 ✓';
  }
}

function checkAutoLogin() {
  const savedToken = localStorage.getItem('syncshift_token');
  const savedExpire = parseInt(localStorage.getItem('syncshift_expire') || '0', 10);
  const savedEmail = localStorage.getItem('syncshift_email');

  // トークンが有効期限内なら即同期
  if (savedToken && Date.now() < savedExpire - 60000) {
    accessToken = savedToken;
    setConnectedUI();
    loadCalendarList();
    loadCalendarEvents();
  } else if (tokenClient && savedEmail) {
    // 期限切れの場合: バックグラウンドでサイレント更新を試みる
    try {
      tokenClient.requestAccessToken({ prompt: '', hint: savedEmail });
    } catch (e) {
      console.warn('Silent refresh prevented by browser', e);
    }
  }
}

authBtn.addEventListener('click', () => {
  if (!tokenClient) {
    showToast('Google SDK初期化中... 少々お待ちください');
    return;
  }
  const savedEmail = localStorage.getItem('syncshift_email');
  const config = { prompt: accessToken ? '' : 'select_account' };
  if (savedEmail) {
    config.hint = savedEmail;
  }
  tokenClient.requestAccessToken(config);
});

// ==========================================
// 再同期（リロード）ボタンのワンタップ処理（確実復旧版）
// ==========================================
async function performFullSync() {
  if (reloadBtn) reloadBtn.classList.add('spinning');
  showToast('カレンダーと同期中...');

  const savedExpire = parseInt(localStorage.getItem('syncshift_expire') || '0', 10);
  const isTokenValid = accessToken && (Date.now() < savedExpire - 30000);

  // トークンが生きているなら直接取得
  if (isTokenValid) {
    try {
      await loadCalendarList();
      await loadCalendarEvents();
      showToast('⚡ 最新の予定に更新しました！');
    } catch (err) {
      console.error('Fetch error with existing token', err);
      // 万が一401なら再認証へフォールバック
      requestFreshTokenAndSync();
    } finally {
      if (reloadBtn) reloadBtn.classList.remove('spinning');
    }
  } else {
    // トークンが無効・切れている場合は正規のトークン取得へ
    requestFreshTokenAndSync();
  }
}

function requestFreshTokenAndSync() {
  if (!tokenClient) {
    initGoogleAuth();
    if (reloadBtn) reloadBtn.classList.remove('spinning');
    showToast('Google SDK初期化中... 少々お待ちください');
    return;
  }

  const savedEmail = localStorage.getItem('syncshift_email');
  
  // コールバックをセットして確実にデータを引く
  const originalCallback = tokenClient.callback;
  tokenClient.callback = async (tokenResponse) => {
    tokenClient.callback = originalCallback;

    if (tokenResponse.error !== undefined) {
      console.error('Auth error:', tokenResponse.error);
      if (reloadBtn) reloadBtn.classList.remove('spinning');
      showToast('Google認証を完了してください');
      return;
    }

    accessToken = tokenResponse.access_token;
    const expiresInMs = (tokenResponse.expires_in || 3600) * 1000;
    localStorage.setItem('syncshift_token', accessToken);
    localStorage.setItem('syncshift_expire', (Date.now() + expiresInMs).toString());

    setConnectedUI();
    await loadCalendarList();
    await loadCalendarEvents();

    if (reloadBtn) reloadBtn.classList.remove('spinning');
    showToast('⚡ 最新の予定に更新しました！');
  };

  const config = { prompt: '' };
  if (savedEmail) {
    config.hint = savedEmail;
  }
  
  try {
    tokenClient.requestAccessToken(config);
  } catch (e) {
    console.warn('requestAccessToken prompt failed, falling back to prompt: select_account', e);
    tokenClient.requestAccessToken({ prompt: 'select_account', hint: savedEmail || '' });
  }
}

if (reloadBtn) {
  reloadBtn.addEventListener('click', () => {
    performFullSync();
  });
}

// カレンダー一覧の読み込み（複数対応）
async function loadCalendarList() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.status === 401) {
      handleAuthExpired();
      return;
    }
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      allCalendars = data.items.map((cal, idx) => ({
        id: cal.id,
        summary: cal.summary + (cal.primary ? ' (メイン)' : ''),
        primary: cal.primary || false,
        backgroundColor: cal.backgroundColor || getFallbackColor(idx)
      }));

      // カレンダー一覧をキャッシュ保存
      localStorage.setItem('syncshift_cached_cals', JSON.stringify(allCalendars));

      // localStorageから以前の選択状態を復元
      const savedSelected = JSON.parse(localStorage.getItem('syncshift_selected_cals') || '[]');
      if (savedSelected.length > 0) {
        selectedCalendarIds = savedSelected.filter(id => allCalendars.some(c => c.id === id));
      }
      if (selectedCalendarIds.length === 0) {
        const primaryCal = allCalendars.find(c => c.primary);
        selectedCalendarIds = primaryCal ? [primaryCal.id] : [allCalendars[0].id];
      }

      renderCalDropdown();
      updateCalFilterUI();
    }
  } catch (err) {
    console.error('Failed to load calendars', err);
  }
}

// 認証が期限切れだった場合の自動ハンドラ
function handleAuthExpired() {
  console.warn('Access token expired. Requesting silent refresh or prompt.');
  const savedEmail = localStorage.getItem('syncshift_email');
  if (tokenClient && savedEmail) {
    // サイレント更新を試行
    tokenClient.requestAccessToken({ prompt: '', hint: savedEmail });
  }
}

function getFallbackColor(idx) {
  const colors = ['#0284c7', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
  return colors[idx % colors.length];
}

// カレンダー選択ドロップダウンの描画
function renderCalDropdown() {
  calCheckboxList.innerHTML = '';
  allCalendars.forEach(cal => {
    const item = document.createElement('label');
    item.className = 'cal-checkbox-item';
    
    const isChecked = selectedCalendarIds.includes(cal.id);
    
    item.innerHTML = `
      <input type="checkbox" value="${cal.id}" ${isChecked ? 'checked' : ''} style="cursor:pointer;">
      <span class="cal-color-dot" style="background-color: ${cal.backgroundColor};"></span>
      <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cal.summary}</span>
    `;

    const checkbox = item.querySelector('input');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      const calId = e.target.value;
      if (e.target.checked) {
        if (!selectedCalendarIds.includes(calId)) selectedCalendarIds.push(calId);
      } else {
        selectedCalendarIds = selectedCalendarIds.filter(id => id !== calId);
      }
      localStorage.setItem('syncshift_selected_cals', JSON.stringify(selectedCalendarIds));
      updateCalFilterUI();
      loadCalendarEvents();
    });

    calCheckboxList.appendChild(item);
  });
}

function updateCalFilterUI() {
  const count = selectedCalendarIds.length;
  calCountBadge.textContent = count;
  if (count === 1) {
    const cal = allCalendars.find(c => c.id === selectedCalendarIds[0]);
    calFilterBtn.querySelector('span:first-child').textContent = cal ? cal.summary : 'カレンダー';
  } else if (count > 1) {
    calFilterBtn.querySelector('span:first-child').textContent = `${count}件のカレンダー`;
  } else {
    calFilterBtn.querySelector('span:first-child').textContent = '未選択';
  }
}

// ドロップダウン開閉
calFilterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  calDropdownPanel.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!calDropdownPanel.contains(e.target) && e.target !== calFilterBtn) {
    calDropdownPanel.classList.remove('open');
  }
});

// 複数カレンダーの予定を並列一括取得
async function loadCalendarEvents() {
  if (!accessToken || selectedCalendarIds.length === 0) {
    calendarEvents = [];
    renderWeek();
    return;
  }

  const weekDates = getWeekDates(currentWeekOffset);
  const timeMin = new Date(weekDates[0]);
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(weekDates[6]);
  timeMax.setHours(23, 59, 59, 999);

  try {
    const fetchPromises = selectedCalendarIds.map(async (calId) => {
      const calObj = allCalendars.find(c => c.id === calId);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}&singleEvents=true&orderBy=startTime`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || []).map(item => ({
        ...item,
        calId: calId,
        calName: calObj ? calObj.summary : '',
        calColor: calObj ? calObj.backgroundColor : '#0284c7'
      }));
    });

    const results = await Promise.all(fetchPromises);
    const allItems = results.flat();

    calendarEvents = [];
    allItems.forEach(item => {
      if (!item.start.dateTime) return;
      const start = new Date(item.start.dateTime);
      const end = new Date(item.end.dateTime);

      calendarEvents.push({
        id: item.id,
        calId: item.calId,
        calName: item.calName,
        calColor: item.calColor,
        title: item.summary || '(予定)',
        dateStr: formatDate(start),
        startHour: start.getHours(),
        startMin: start.getMinutes(),
        endHour: end.getHours(),
        endMin: end.getMinutes()
      });
    });

    // 取得した予定データをローカルキャッシュ保存（次回起動時も即表示）
    localStorage.setItem('syncshift_cached_events', JSON.stringify(calendarEvents));

    renderWeek();
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

// ==========================================
// 日付 & カレンダー描画
// ==========================================
function getWeekDates(offsetWeeks = 0) {
  const now = new Date();
  const currentDay = now.getDay();
  const mondayOffset = (currentDay === 0 ? -6 : 1) - currentDay;
  
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset + (offsetWeeks * 7));
  monday.setHours(0,0,0,0);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    weekDates.push(d);
  }
  return weekDates;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(slotIndex) {
  const totalMinutes = (START_HOUR * 60) + (slotIndex * SLOT_MINUTES);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function initTimeLabels() {
  timeLabels.innerHTML = '';
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const slotEl = document.createElement('div');
    slotEl.className = 'time-slot-label';
    if (slot % SLOTS_PER_HOUR === 0) {
      const hour = START_HOUR + Math.floor(slot / SLOTS_PER_HOUR);
      slotEl.textContent = `${hour}:00`;
    }
    timeLabels.appendChild(slotEl);
  }
}

function renderWeek() {
  const weekDates = getWeekDates(currentWeekOffset);
  const dayNames = ['月', '火', '水', '木', '金', '土', '日'];
  const today = new Date();
  const todayStr = formatDate(today);

  const startStr = `${weekDates[0].getMonth() + 1}/${weekDates[0].getDate()}`;
  const endStr = `${weekDates[6].getMonth() + 1}/${weekDates[6].getDate()}`;
  weekRangeLabel.textContent = `${weekDates[0].getFullYear()}/${startStr} - ${endStr}`;

  while (gridHeader.children.length > 1) {
    gridHeader.removeChild(gridHeader.lastChild);
  }

  weekDates.forEach((date, i) => {
    const dStr = formatDate(date);
    const cell = document.createElement('div');
    cell.className = 'header-cell';
    if (dStr === todayStr) cell.classList.add('is-today');
    if (i === 5) cell.classList.add('is-sat');
    if (i === 6) cell.classList.add('is-sun');

    cell.innerHTML = `
      <div class="day-name">${dayNames[i]}</div>
      <div class="day-number">${date.getDate()}</div>
    `;
    gridHeader.appendChild(cell);
  });

  const existingCols = gridBody.querySelectorAll('.day-column');
  existingCols.forEach(c => c.remove());

  weekDates.forEach((date, dayIdx) => {
    const dateStr = formatDate(date);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = dayIdx;
    col.dataset.dateStr = dateStr;

    for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
      const slotCell = document.createElement('div');
      slotCell.className = 'slot-cell';
      slotCell.dataset.slotIndex = slot;
      col.appendChild(slotCell);
    }

    renderCommittedEventsForDay(col, dateStr);
    renderPendingSchedulesForDay(col, dateStr);

    gridBody.appendChild(col);
  });

  updateFooterSummary();
}

function renderCommittedEventsForDay(colEl, dateStr) {
  const events = calendarEvents.filter(e => e.dateStr === dateStr);
  events.forEach(evt => {
    const startMinutes = (evt.startHour * 60 + evt.startMin) - (START_HOUR * 60);
    const endMinutes = (evt.endHour * 60 + evt.endMin) - (START_HOUR * 60);
    if (startMinutes < 0 || endMinutes <= startMinutes) return;

    const startSlots = startMinutes / SLOT_MINUTES;
    const durationSlots = (endMinutes - startMinutes) / SLOT_MINUTES;
    const cellH = getActualCellHeight();
    const topPx = startSlots * cellH;
    const heightPx = Math.max(durationSlots * cellH - 2, 22);

    const block = document.createElement('div');
    block.className = 'committed-block';
    block.style.top = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    
    // カレンダー固有の色がある場合は適用
    if (evt.calColor) {
      block.style.borderLeftColor = evt.calColor;
      block.style.background = `linear-gradient(135deg, ${evt.calColor}cc, ${evt.calColor}99)`;
    }

    block.innerHTML = `
      <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        <span style="font-size:0.6rem; opacity:0.85; display:block;">${evt.calName}</span>
        ${evt.title}
      </div>
      <div style="font-size:0.65rem;">${formatTime(startSlots)} - ${formatTime(startSlots + durationSlots)}</div>
    `;
    
    // タップで詳細＆削除モーダルを開く
    block.addEventListener('click', () => {
      openEditModal('committed', {
        id: evt.id,
        calId: evt.calId,
        calName: evt.calName,
        title: evt.title,
        dateStr: evt.dateStr,
        startSlot: startSlots,
        endSlot: startSlots + durationSlots - 1
      });
    });

    colEl.appendChild(block);
  });
}

function renderPendingSchedulesForDay(colEl, dateStr) {
  const list = pendingSchedules.filter(p => p.dateStr === dateStr);
  const cellH = getActualCellHeight();
  list.forEach(p => {
    const topPx = p.startSlot * cellH;
    const heightPx = (p.endSlot - p.startSlot + 1) * cellH;

    const startTimeStr = formatTime(p.startSlot);
    const endTimeStr = formatTime(p.endSlot + 1);

    const calObj = allCalendars.find(c => c.id === p.targetCalId);
    const calLabel = calObj ? calObj.summary : 'カレンダー';

    const block = document.createElement('div');
    block.className = 'pending-block';
    block.style.top = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    block.innerHTML = `
      <div>
        <span class="block-badge" style="background:#0284c7;">${calLabel}</span>
        <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.title}</div>
      </div>
      <div style="font-size:0.65rem;">${startTimeStr} - ${endTimeStr}</div>
    `;
    
    // タップで編集・削除モーダルを開く
    block.addEventListener('click', () => {
      openEditModal('edit', p);
    });

    colEl.appendChild(block);
  });
}

window.removePendingSchedule = function(id, e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  pendingSchedules = pendingSchedules.filter(p => p.id !== id);
  resetDragState();
  renderWeek();
};

window.deleteCalendarEvent = async function(id, calId, e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!confirm('この予定をGoogleカレンダーから削除しますか？')) return;

  if (!accessToken) {
    calendarEvents = calendarEvents.filter(item => item.id !== id);
    renderWeek();
    showToast('予定を解除しました（モック）');
    return;
  }

  const targetCalId = encodeURIComponent(calId || 'primary');
  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${targetCalId}/events/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.ok) {
      showToast('Googleカレンダーから削除しました');
      loadCalendarEvents();
    }
  } catch (err) {
    showToast('削除リクエストエラー');
  }
};

// ==========================================
// タッチ＆ドラッグ操作（上下スクロール＆左右スワイプ完全対応）
// ==========================================
function getSlotAndDayFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  const slotCell = el.closest('.slot-cell');
  if (slotCell) {
    const col = slotCell.closest('.day-column');
    if (col) {
      return {
        dayIndex: parseInt(col.dataset.dayIndex, 10),
        dateStr: col.dataset.dateStr,
        slotIndex: parseInt(slotCell.dataset.slotIndex, 10),
        colEl: col
      };
    }
  }
  return null;
}

function resetDragState() {
  isDragging = false;
  isTouchSelectionActive = false;
  if (touchHoldTimer) {
    clearTimeout(touchHoldTimer);
    touchHoldTimer = null;
  }
  dragStart = null;
  dragCurrent = null;
  stopAutoScroll();
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();
}

function updateActiveDragOverlay() {
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (!dragStart || !dragCurrent) return;

  const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
  const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);
  const targetCol = gridBody.querySelector(`.day-column[data-day-index="${dragStart.dayIndex}"]`);
  if (!targetCol) return;

  const cellH = getActualCellHeight();
  const topPx = minSlot * cellH;
  const heightPx = (maxSlot - minSlot + 1) * cellH;

  const startTimeStr = formatTime(minSlot);
  const endTimeStr = formatTime(maxSlot + 1);

  const overlay = document.createElement('div');
  overlay.className = 'selection-overlay';
  overlay.style.top = `${topPx}px`;
  overlay.style.height = `${heightPx}px`;
  overlay.style.left = '2px';
  overlay.style.right = '2px';

  overlay.innerHTML = `
    <div class="sel-title">時間帯を指定中...</div>
    <div class="sel-time">${startTimeStr} 〜 ${endTimeStr}</div>
  `;
  targetCol.appendChild(overlay);
}

// マウス操作（PC用）
gridBody.addEventListener('mousedown', (e) => {
  if (e.target.closest('.del-btn') || e.target.closest('.committed-block') || e.target.closest('.pending-block')) return;
  const point = getSlotAndDayFromPoint(e.clientX, e.clientY);
  if (point) {
    isDragging = true;
    dragStart = point;
    dragCurrent = point;
    updateActiveDragOverlay();
    startAutoScroll();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging || !dragStart) return;
  lastPointerClientY = e.clientY;
  const point = getSlotAndDayFromPoint(e.clientX, e.clientY);
  if (point && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    updateActiveDragOverlay();
  }
});

window.addEventListener('mouseup', () => {
  if (isDragging) finishDragSelection();
});

// タッチ操作（スマホ用：左右スワイプ＆スクロール優先）
gridBody.addEventListener('touchstart', (e) => {
  if (e.target.closest('.del-btn') || e.target.closest('.committed-block') || e.target.closest('.pending-block')) return;

  const touch = e.touches[0];
  touchOriginX = touch.clientX;
  touchOriginY = touch.clientY;
  isTouchSelectionActive = false;

  const point = getSlotAndDayFromPoint(touch.clientX, touch.clientY);
  if (!point) return;

  // 指を置いて150ms留まったら「時間帯選択モード」へ移行
  touchHoldTimer = setTimeout(() => {
    isTouchSelectionActive = true;
    isDragging = true;
    dragStart = point;
    dragCurrent = point;
    updateActiveDragOverlay();
    startAutoScroll();
  }, 160);
}, { passive: true });

gridBody.addEventListener('touchmove', (e) => {
  const touch = e.touches[0];
  const deltaX = touch.clientX - touchOriginX;
  const deltaY = touch.clientY - touchOriginY;

  // 指が大きく動いた場合、長押しタイマーをキャンセルして通常スクロール/スワイプを許可
  if (!isTouchSelectionActive) {
    if (Math.abs(deltaX) > 15 || Math.abs(deltaY) > 15) {
      if (touchHoldTimer) clearTimeout(touchHoldTimer);
    }
    return; // 通常の上下スクロールをブラウザに委ねる
  }

  // 時間選択モード中の場合のみスクロールを抑止して選択枠を追従
  e.preventDefault();
  lastPointerClientY = touch.clientY;
  const point = getSlotAndDayFromPoint(touch.clientX, touch.clientY);
  if (point && dragStart && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    updateActiveDragOverlay();
  }
}, { passive: false });

gridBody.addEventListener('touchend', (e) => {
  if (touchHoldTimer) clearTimeout(touchHoldTimer);

  if (isTouchSelectionActive && isDragging) {
    finishDragSelection();
    return;
  }

  // 左右スワイプによる週移動の判定（水平移動 > 60px かつ 垂直移動 < 40px）
  const touch = e.changedTouches[0];
  const deltaX = touch.clientX - touchOriginX;
  const deltaY = touch.clientY - touchOriginY;

  if (Math.abs(deltaX) > 65 && Math.abs(deltaY) < 45) {
    if (deltaX < 0) {
      // 左スワイプ ➔ 次の週へ
      nextWeekBtn.click();
    } else {
      // 右スワイプ ➔ 前の週へ
      prevWeekBtn.click();
    }
  }

  resetDragState();
});

// ヘッダー部分のスワイプ検知
gridHeader.addEventListener('touchstart', (e) => {
  touchOriginX = e.touches[0].clientX;
  touchOriginY = e.touches[0].clientY;
}, { passive: true });

gridHeader.addEventListener('touchend', (e) => {
  const touch = e.changedTouches[0];
  const deltaX = touch.clientX - touchOriginX;
  const deltaY = touch.clientY - touchOriginY;

  if (Math.abs(deltaX) > 50 && Math.abs(deltaY) < 40) {
    if (deltaX < 0) nextWeekBtn.click();
    else prevWeekBtn.click();
  }
});

function finishDragSelection() {
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (dragStart && dragCurrent) {
    const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
    const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);

    // デフォルト登録先: 上部で選ばれているカレンダー（最後に選択した、またはチェックが入っているカレンダー）
    const defaultCalId = (selectedCalendarIds && selectedCalendarIds.length > 0)
      ? selectedCalendarIds[selectedCalendarIds.length - 1] 
      : (allCalendars[0] ? allCalendars[0].id : 'primary');

    const calObj = allCalendars.find(c => c.id === defaultCalId);
    // カレンダー名そのものを件名デフォルトにセット（「 (メイン)」などのサフィックスは綺麗に除外）
    const rawName = calObj ? calObj.summary.replace(' (メイン)', '').trim() : '予定';

    const newPendingData = {
      id: 'pending-' + Date.now() + Math.random(),
      dayIndex: dragStart.dayIndex,
      dateStr: dragStart.dateStr,
      startSlot: minSlot,
      endSlot: maxSlot,
      title: rawName,
      targetCalId: defaultCalId
    };

    resetDragState();
    openEditModal('create', newPendingData);
  } else {
    resetDragState();
  }
}

// ==========================================
// 自動スクロール
// ==========================================
function checkAutoScroll() {
  if (!isDragging) {
    stopAutoScroll();
    return;
  }

  const rect = calendarContainer.getBoundingClientRect();
  const threshold = 50;
  const scrollSpeed = 14;

  if (lastPointerClientY > rect.bottom - threshold && lastPointerClientY <= rect.bottom + 40) {
    calendarContainer.scrollTop += scrollSpeed;
  } else if (lastPointerClientY < rect.top + threshold && lastPointerClientY >= rect.top - 40) {
    calendarContainer.scrollTop -= scrollSpeed;
  }
}

function startAutoScroll() {
  if (!autoScrollTimer) autoScrollTimer = setInterval(checkAutoScroll, 20);
}

function stopAutoScroll() {
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

// ==========================================
// モーダル操作ロジック（登録先カレンダー選択対応）
// ==========================================
function openEditModal(mode, data) {
  editingTarget = { mode, data };
  const startTimeStr = formatTime(data.startSlot);
  const endTimeStr = formatTime(data.endSlot + 1);

  // 登録先カレンダープルダウンの選択肢を生成
  eventCalSelect.innerHTML = '';
  allCalendars.forEach(cal => {
    const opt = document.createElement('option');
    opt.value = cal.id;
    opt.textContent = cal.summary;
    if (data.targetCalId && data.targetCalId === cal.id) {
      opt.selected = true;
    } else if (data.calId && data.calId === cal.id) {
      opt.selected = true;
    }
    eventCalSelect.appendChild(opt);
  });

  if (mode === 'create') {
    modalTitle.textContent = '予定の作成';
    modalDeleteBtn.style.display = 'none';
    if (modalCopyBtn) modalCopyBtn.style.display = 'none';
    modalSaveBtn.textContent = '決定 (Enter)';
    eventTitleInput.disabled = false;
    eventCalSelect.disabled = false;

    // カレンダー切り替え時に件名がデフォルトのままなら自動追従させる
    eventCalSelect.onchange = () => {
      const selectedCal = allCalendars.find(c => c.id === eventCalSelect.value);
      if (selectedCal) {
        eventTitleInput.value = selectedCal.summary.replace(' (メイン)', '').trim();
        eventTitleInput.select();
      }
    };
  } else if (mode === 'edit') {
    modalTitle.textContent = '未登録予定の編集';
    modalDeleteBtn.style.display = 'inline-block';
    if (modalCopyBtn) modalCopyBtn.style.display = 'inline-block';
    modalDeleteBtn.textContent = 'この予定を削除';
    modalSaveBtn.textContent = '変更を保存';
    eventTitleInput.disabled = false;
    eventCalSelect.disabled = false;
  } else if (mode === 'committed') {
    modalTitle.textContent = 'Googleカレンダーの予定';
    modalDeleteBtn.style.display = 'inline-block';
    if (modalCopyBtn) modalCopyBtn.style.display = 'inline-block';
    modalDeleteBtn.textContent = 'Googleカレンダーから削除';
    modalSaveBtn.textContent = '閉じる';
    eventTitleInput.disabled = true;
    eventCalSelect.disabled = true;
  }

  modalTimeRange.textContent = `📅 ${data.dateStr}  ⏰ ${startTimeStr} 〜 ${endTimeStr}`;
  eventTitleInput.value = data.title || '';

  modalOverlay.classList.add('open');

  if (mode !== 'committed') {
    setTimeout(() => {
      eventTitleInput.focus();
      eventTitleInput.select();
    }, 100);
  }
}

function closeEditModal() {
  modalOverlay.classList.remove('open');
  editingTarget = null;
  resetDragState();
}

function saveEditModal() {
  if (!editingTarget) return;

  const { mode, data } = editingTarget;
  if (mode === 'committed') {
    closeEditModal();
    return;
  }

  const titleVal = eventTitleInput.value.trim() || '予定';
  const selectedCalId = eventCalSelect.value;

  if (mode === 'create') {
    data.title = titleVal;
    data.targetCalId = selectedCalId;
    pendingSchedules.push(data);
  } else if (mode === 'edit') {
    const target = pendingSchedules.find(p => p.id === data.id);
    if (target) {
      target.title = titleVal;
      target.targetCalId = selectedCalId;
    }
  }

  closeEditModal();
  renderWeek();
}

// モーダル内削除ボタン
modalDeleteBtn.addEventListener('click', () => {
  if (!editingTarget) return;
  const { mode, data } = editingTarget;

  if (mode === 'edit') {
    removePendingSchedule(data.id);
    closeEditModal();
  } else if (mode === 'committed') {
    closeEditModal();
    deleteCalendarEvent(data.id, data.calId);
  }
});

// モーダル内「翌週にコピー」ボタン
if (modalCopyBtn) {
  modalCopyBtn.addEventListener('click', () => {
    if (!editingTarget) return;
    const { data } = editingTarget;

    // 現在の日付（YYYY-MM-DD）に +7日 した日付を計算
    const parts = data.dateStr.split('-').map(Number);
    const currentDate = new Date(parts[0], parts[1] - 1, parts[2]);
    const nextWeekDate = new Date(currentDate);
    nextWeekDate.setDate(currentDate.getDate() + 7);
    const nextDateStr = formatDate(nextWeekDate);

    // 翌週の未登録予定データを作成
    const copiedPendingData = {
      id: 'pending-' + Date.now() + Math.random(),
      dayIndex: data.dayIndex !== undefined ? data.dayIndex : 0,
      dateStr: nextDateStr,
      startSlot: data.startSlot,
      endSlot: data.endSlot,
      title: data.title,
      targetCalId: data.targetCalId || data.calId || (selectedCalendarIds[0] || 'primary')
    };

    pendingSchedules.push(copiedPendingData);

    closeEditModal();

    // カレンダー表示を自動的に「翌週」へ切り替え！
    currentWeekOffset++;
    renderWeek();
    if (accessToken) loadCalendarEvents();

    showToast(`⚡ 翌週（${nextDateStr}）へ予定をコピーしました！`);
  });
}

modalSaveBtn.addEventListener('click', saveEditModal);
modalCancelBtn.addEventListener('click', closeEditModal);
modalCloseBtn.addEventListener('click', closeEditModal);

eventTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveEditModal();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeEditModal();
  }
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeEditModal();
});

// フッターサマリー更新
function updateFooterSummary() {
  const count = pendingSchedules.length;
  if (count === 0) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Googleカレンダーへ一括登録</span>';
    selectionInfo.innerHTML = '未登録: <span>0</span> 件 (画面を長押しして予定を追加)';
    clearBtn.style.display = 'none';
  } else {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<span>⚡ 選択した ${count} 件を一括登録</span>`;
    selectionInfo.innerHTML = `登録待ち: <span>${count}</span> 件のスケジュールがあります`;
    clearBtn.style.display = 'block';
  }
}

clearBtn.addEventListener('click', () => {
  if (confirm('登録待ちのスケジュールをすべてクリアしますか？')) {
    pendingSchedules = [];
    resetDragState();
    renderWeek();
  }
});

// ==========================================
// Googleカレンダー一括登録 (バッチ実行・個別カレンダーへ振り分け)
// ==========================================
submitBtn.addEventListener('click', async () => {
  if (pendingSchedules.length === 0) return;

  const count = pendingSchedules.length;
  if (!confirm(`選択された ${count} 件のスケジュールをそれぞれのカレンダーへ一括登録しますか？`)) {
    return;
  }

  resetDragState();

  if (!accessToken) {
    pendingSchedules.forEach(p => {
      const startTimeStr = formatTime(p.startSlot);
      const endTimeStr = formatTime(p.endSlot + 1);
      const [sH, sM] = startTimeStr.split(':').map(Number);
      const [eH, eM] = endTimeStr.split(':').map(Number);

      const calObj = allCalendars.find(c => c.id === p.targetCalId);

      calendarEvents.push({
        id: 'local-' + Date.now() + Math.random(),
        calId: p.targetCalId,
        calName: calObj ? calObj.summary : 'カレンダー',
        calColor: calObj ? calObj.backgroundColor : '#0284c7',
        title: p.title,
        dateStr: p.dateStr,
        startHour: sH,
        startMin: sM,
        endHour: eH,
        endMin: eM
      });
    });

    pendingSchedules = [];
    showToast(`（モック）${count} 件の予定を一括登録しました！`);
    renderWeek();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span>⏳ ${count} 件を送信中...</span>`;

  try {
    const promises = pendingSchedules.map(p => {
      const targetCalId = p.targetCalId || selectedCalendarIds[0] || 'primary';
      const startTimeStr = formatTime(p.startSlot);
      const endTimeStr = formatTime(p.endSlot + 1);
      const startDateTime = `${p.dateStr}T${startTimeStr}:00+09:00`;
      const endDateTime = `${p.dateStr}T${endTimeStr}:00+09:00`;

      return fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalId)}/events`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary: p.title,
          description: 'sync-shift から一括登録',
          start: { dateTime: startDateTime, timeZone: 'Asia/Tokyo' },
          end: { dateTime: endDateTime, timeZone: 'Asia/Tokyo' }
        })
      });
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.ok).length;

    pendingSchedules = [];
    showToast(`⚡ ${successCount} 件のスケジュールを一括登録完了！`);
    await loadCalendarEvents();
  } catch (err) {
    console.error('Batch insert error', err);
    showToast('一括登録中にエラーが発生しました');
  } finally {
    submitBtn.disabled = false;
    resetDragState();
    renderWeek();
  }
});

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

prevWeekBtn.addEventListener('click', () => {
  currentWeekOffset--;
  resetDragState();
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

nextWeekBtn.addEventListener('click', () => {
  currentWeekOffset++;
  resetDragState();
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

// 初期化
initTimeLabels();
renderWeek();
initGoogleAuth();
