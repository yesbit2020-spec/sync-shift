// sync-shift アプリケーションコアロジック (Google Calendar API 連携版)

// === 認証設定 ===
const CLIENT_ID = '107057563168-ocp8fupandai0hima45lpvl1ut070crk.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';

let tokenClient = null;
let accessToken = null;

// === カレンダー設定 ===
const START_HOUR = 7;
const END_HOUR = 24; // 7:00 〜 24:00 (17時間)
const SLOT_MINUTES = 30; // 30分単位
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR;
const CELL_HEIGHT = 44; // px

let currentWeekOffset = 0; // 0 = 今週
let isDragging = false;
let dragStart = null;
let dragCurrent = null;
let currentSelection = null;

// カレンダーイベントキャッシュ
let calendarEvents = [];

// DOM要素
const gridHeader = document.getElementById('gridHeader');
const gridBody = document.getElementById('gridBody');
const timeLabels = document.getElementById('timeLabels');
const weekRangeLabel = document.getElementById('weekRangeLabel');
const prevWeekBtn = document.getElementById('prevWeekBtn');
const nextWeekBtn = document.getElementById('nextWeekBtn');
const calendarSelect = document.getElementById('calendarSelect');
const submitBtn = document.getElementById('submitBtn');
const clearBtn = document.getElementById('clearBtn');
const selectionInfo = document.getElementById('selectionInfo');
const toast = document.getElementById('toast');
const authBtn = document.getElementById('authBtn');
const authBtnText = document.getElementById('authBtnText');

// ==========================================
// Google Identity Services (GIS) 認証処理
// ==========================================
function initGoogleAuth() {
  if (typeof google === 'undefined') {
    setTimeout(initGoogleAuth, 200);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      if (tokenResponse.error !== undefined) {
        showToast('Google認証エラー: ' + tokenResponse.error);
        return;
      }
      accessToken = tokenResponse.access_token;
      authBtn.classList.add('connected');
      authBtnText.textContent = 'Google連携中 ✓';
      showToast('⚡ Googleアカウントの認証に成功しました！');
      
      // カレンダー一覧を取得
      await loadCalendarList();
      // 表示中の週のイベントを取得
      await loadCalendarEvents();
    },
  });
}

authBtn.addEventListener('click', () => {
  if (!tokenClient) {
    showToast('Google SDKの初期化中です。少々お待ちください。');
    return;
  }
  // トークン取得ダイアログ表示
  tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
});

// カレンダー一覧の取得
async function loadCalendarList() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      calendarSelect.innerHTML = '';
      data.items.forEach(cal => {
        const opt = document.createElement('option');
        opt.value = cal.id;
        opt.textContent = cal.summary + (cal.primary ? ' (メイン)' : '');
        calendarSelect.appendChild(opt);
      });
      showToast(`カレンダーを${data.items.length}件ロードしました`);
    }
  } catch (err) {
    console.error('Failed to load calendars', err);
    showToast('カレンダー一覧の取得に失敗しました');
  }
}

// 選択中週の既存予定を取得
async function loadCalendarEvents() {
  if (!accessToken) return;

  const weekDates = getWeekDates(currentWeekOffset);
  const timeMin = new Date(weekDates[0]);
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(weekDates[6]);
  timeMax.setHours(23, 59, 59, 999);

  const calId = encodeURIComponent(calendarSelect.value || 'primary');

  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    
    calendarEvents = [];
    if (data.items) {
      data.items.forEach(item => {
        if (!item.start.dateTime) return; // 終日予定は一旦スキップ
        const start = new Date(item.start.dateTime);
        const end = new Date(item.end.dateTime);

        calendarEvents.push({
          id: item.id,
          title: item.summary || '(タイトルなし)',
          dateStr: formatDate(start),
          startHour: start.getHours(),
          startMin: start.getMinutes(),
          endHour: end.getHours(),
          endMin: end.getMinutes(),
          category: 'work'
        });
      });
    }
    renderWeek();
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

// カレンダー変更時にイベント再取得
calendarSelect.addEventListener('change', () => {
  if (accessToken) loadCalendarEvents();
  if (currentSelection) updateSelectionOverlay();
});

// ==========================================
// カレンダー描画 & 日付ロジック
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
    gridBody.appendChild(col);
  });

  clearSelection();
}

function renderCommittedEventsForDay(colEl, dateStr) {
  const events = calendarEvents.filter(e => e.dateStr === dateStr);
  events.forEach(evt => {
    const startMinutes = (evt.startHour * 60 + evt.startMin) - (START_HOUR * 60);
    const endMinutes = (evt.endHour * 60 + evt.endMin) - (START_HOUR * 60);

    if (startMinutes < 0 || endMinutes <= startMinutes) return;

    const startSlots = startMinutes / SLOT_MINUTES;
    const durationSlots = (endMinutes - startMinutes) / SLOT_MINUTES;

    const topPx = startSlots * CELL_HEIGHT;
    const heightPx = Math.max(durationSlots * CELL_HEIGHT - 2, 24);

    const block = document.createElement('div');
    block.className = `committed-block ${evt.category || 'work'}`;
    block.style.top = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    block.innerHTML = `
      <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${evt.title}</div>
      <div style="font-size:0.68rem;">${formatTime(startSlots)} - ${formatTime(startSlots + durationSlots)}</div>
      <button class="del-btn" title="Googleカレンダーから削除" onclick="deleteCalendarEvent('${evt.id}', event)">×</button>
    `;
    colEl.appendChild(block);
  });
}

// Googleカレンダー上のイベント削除
window.deleteCalendarEvent = async function(id, e) {
  e.stopPropagation();
  if (!confirm('この予定をGoogleカレンダーから削除しますか？')) return;

  if (!accessToken) {
    // オフライン・モック削除
    const idx = calendarEvents.findIndex(item => item.id === id);
    if (idx !== -1) calendarEvents.splice(idx, 1);
    renderWeek();
    showToast('予定を解除しました（モック）');
    return;
  }

  const calId = encodeURIComponent(calendarSelect.value || 'primary');
  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.ok) {
      showToast('Googleカレンダーから削除しました');
      loadCalendarEvents();
    } else {
      showToast('削除に失敗しました');
    }
  } catch (err) {
    console.error(err);
    showToast('削除リクエストエラー');
  }
};

// ==========================================
// ドラッグ・タッチ選択処理
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

function updateSelectionOverlay() {
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (!currentSelection) {
    submitBtn.disabled = true;
    selectionInfo.innerHTML = '未選択 (画面をなぞって時間帯を指定)';
    return;
  }

  const { dayIndex, startSlot, endSlot, dateStr } = currentSelection;
  const targetCol = gridBody.querySelector(`.day-column[data-day-index="${dayIndex}"]`);
  if (!targetCol) return;

  const topPx = startSlot * CELL_HEIGHT;
  const heightPx = (endSlot - startSlot + 1) * CELL_HEIGHT;

  const startTimeStr = formatTime(startSlot);
  const endTimeStr = formatTime(endSlot + 1);

  const overlay = document.createElement('div');
  overlay.className = 'selection-overlay';
  overlay.style.top = `${topPx}px`;
  overlay.style.height = `${heightPx}px`;
  overlay.style.left = '3px';
  overlay.style.right = '3px';

  const calType = calendarSelect.options[calendarSelect.selectedIndex].text;

  overlay.innerHTML = `
    <div class="sel-title">選択中: ${calType}</div>
    <div class="sel-time">${startTimeStr} 〜 ${endTimeStr}</div>
  `;

  targetCol.appendChild(overlay);

  submitBtn.disabled = false;
  selectionInfo.innerHTML = `<span>${dateStr}</span> <span>${startTimeStr} - ${endTimeStr}</span> を選択中`;
}

function clearSelection() {
  currentSelection = null;
  dragStart = null;
  dragCurrent = null;
  isDragging = false;
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();
  submitBtn.disabled = true;
  selectionInfo.innerHTML = '未選択 (画面をなぞって時間帯を指定)';
}

function handlePointerDown(e) {
  if (e.target.closest('.del-btn') || e.target.closest('.committed-block')) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const point = getSlotAndDayFromPoint(clientX, clientY);

  if (point) {
    isDragging = true;
    dragStart = point;
    dragCurrent = point;
    calculateSelection();
  }
}

function handlePointerMove(e) {
  if (!isDragging || !dragStart) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const point = getSlotAndDayFromPoint(clientX, clientY);

  if (point && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    calculateSelection();
  }
}

function handlePointerUp() {
  if (isDragging) {
    isDragging = false;
  }
}

function calculateSelection() {
  if (!dragStart || !dragCurrent) return;

  const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
  const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);

  currentSelection = {
    dayIndex: dragStart.dayIndex,
    dateStr: dragStart.dateStr,
    startSlot: minSlot,
    endSlot: maxSlot
  };

  updateSelectionOverlay();
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

// ==========================================
// Googleカレンダーへ一括登録 (events.insert)
// ==========================================
submitBtn.addEventListener('click', async () => {
  if (!currentSelection) return;

  const calId = calendarSelect.value || 'primary';
  const calName = calendarSelect.options[calendarSelect.selectedIndex].text;
  const startTimeStr = formatTime(currentSelection.startSlot);
  const endTimeStr = formatTime(currentSelection.endSlot + 1);

  // イベントタイトルをプロンプトで入力可能に（デフォルト値あり）
  const eventTitle = prompt('カレンダーに登録する予定のタイトルを入力してください:', `${calName.split(' ')[0]} 予定`);
  if (!eventTitle) return;

  // RFC3339 形式の日時文字列作成 (日本時間 JST +09:00)
  const startDateTime = `${currentSelection.dateStr}T${startTimeStr}:00+09:00`;
  const endDateTime = `${currentSelection.dateStr}T${endTimeStr}:00+09:00`;

  if (!accessToken) {
    // Google未連携時のローカルシミュレーション
    const [sH, sM] = startTimeStr.split(':').map(Number);
    const [eH, eM] = endTimeStr.split(':').map(Number);
    calendarEvents.push({
      id: 'local-' + Date.now(),
      title: eventTitle,
      dateStr: currentSelection.dateStr,
      startHour: sH,
      startMin: sM,
      endHour: eH,
      endMin: eM,
      category: 'work'
    });
    showToast(`（モック）${currentSelection.dateStr} [${startTimeStr}-${endTimeStr}] をローカル登録しました`);
    renderWeek();
    return;
  }

  // 本番 Google Calendar API: events.insert 実行
  submitBtn.disabled = true;
  submitBtn.textContent = '登録中...';

  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: eventTitle,
        description: 'sync-shift から一括登録された予定',
        start: { dateTime: startDateTime, timeZone: 'Asia/Tokyo' },
        end: { dateTime: endDateTime, timeZone: 'Asia/Tokyo' }
      })
    });

    if (res.ok) {
      showToast(`⚡ Googleカレンダー（${calName}）へ正常に登録完了！`);
      await loadCalendarEvents();
    } else {
      const errData = await res.json();
      showToast(`登録エラー: ${errData.error?.message || '不明なエラー'}`);
    }
  } catch (err) {
    console.error('Insert Event Error:', err);
    showToast('登録リクエストに失敗しました');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Googleカレンダーへ一括登録</span>';
  }
});

clearBtn.addEventListener('click', clearSelection);

prevWeekBtn.addEventListener('click', () => {
  currentWeekOffset--;
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

nextWeekBtn.addEventListener('click', () => {
  currentWeekOffset++;
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

// イベントリスナー
gridBody.addEventListener('touchstart', handlePointerDown, { passive: false });
gridBody.addEventListener('touchmove', handlePointerMove, { passive: false });
window.addEventListener('touchend', handlePointerUp);

gridBody.addEventListener('mousedown', handlePointerDown);
window.addEventListener('mousemove', handlePointerMove);
window.addEventListener('mouseup', handlePointerUp);

// 初期化起動
initTimeLabels();
renderWeek();
initGoogleAuth();
