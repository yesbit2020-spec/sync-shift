// sync-shift アプリケーションコアロジック
// - 複数スケジュール連続ドラッグ選択（キューイング）
// - 見切れ時のドラッグ自動スクロール (Auto-Scroll)
// - Google Calendar API 一括バッチ登録

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

// ★ 複数選択用キュー: 画面上でドラッグして追加した「未送信」の予定リスト
let pendingSchedules = [];

// Googleカレンダーから取得した「確定済み」イベントリスト
let calendarEvents = [];

// 自動スクロール用インターバル & ポインタ位置
let autoScrollTimer = null;
let lastPointerClientY = 0;

// モーダル編集ターゲット
let editingTarget = null; // { mode: 'create' | 'edit', data: ... }

// DOM要素
const calendarContainer = document.getElementById('calendarContainer');
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

// モーダルDOM要素
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalTimeRange = document.getElementById('modalTimeRange');
const eventTitleInput = document.getElementById('eventTitleInput');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalSaveBtn = document.getElementById('modalSaveBtn');

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
      
      await loadCalendarList();
      await loadCalendarEvents();
    },
  });
}

authBtn.addEventListener('click', () => {
  if (!tokenClient) {
    showToast('Google SDK初期化中... 少々お待ちください');
    return;
  }
  tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
});

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
  }
}

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
        if (!item.start.dateTime) return;
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

calendarSelect.addEventListener('change', () => {
  if (accessToken) loadCalendarEvents();
});

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

    // 確定済みイベント描画
    renderCommittedEventsForDay(col, dateStr);

    // 未送信キューのブロックを描画
    renderPendingSchedulesForDay(col, dateStr);

    gridBody.appendChild(col);
  });

  updateFooterSummary();
}

// 確定済みイベント
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
      <button class="del-btn" title="カレンダーから削除" onclick="deleteCalendarEvent('${evt.id}', event)">×</button>
    `;
    colEl.appendChild(block);
  });
}

// 未送信キューの描画（クリックでタイトル再編集可能）
function renderPendingSchedulesForDay(colEl, dateStr) {
  const list = pendingSchedules.filter(p => p.dateStr === dateStr);
  list.forEach(p => {
    const topPx = p.startSlot * CELL_HEIGHT;
    const heightPx = (p.endSlot - p.startSlot + 1) * CELL_HEIGHT;

    const startTimeStr = formatTime(p.startSlot);
    const endTimeStr = formatTime(p.endSlot + 1);

    const block = document.createElement('div');
    block.className = 'pending-block';
    block.style.top = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    block.innerHTML = `
      <div>
        <span class="block-badge">未登録 (タップで編集)</span>
        <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.title}</div>
      </div>
      <div style="font-size:0.68rem;">${startTimeStr} - ${endTimeStr}</div>
      <button class="del-btn" title="取り消し" onclick="removePendingSchedule('${p.id}', event)">×</button>
    `;
    
    // タップ・クリックで再編集モーダルを開く
    block.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) return;
      openEditModal('edit', p);
    });

    colEl.appendChild(block);
  });
}

// 未登録ブロックの単体消去
window.removePendingSchedule = function(id, e) {
  if (e) e.stopPropagation();
  pendingSchedules = pendingSchedules.filter(p => p.id !== id);
  renderWeek();
};

window.deleteCalendarEvent = async function(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('この予定をGoogleカレンダーから削除しますか？')) return;

  if (!accessToken) {
    calendarEvents = calendarEvents.filter(item => item.id !== id);
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
    }
  } catch (err) {
    showToast('削除リクエストエラー');
  }
};

// ==========================================
// ドラッグ & 見切れ時の自動スクロール (Auto-Scroll)
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

// 自動スクロール監視ループ
function checkAutoScroll() {
  if (!isDragging) {
    stopAutoScroll();
    return;
  }

  const rect = calendarContainer.getBoundingClientRect();
  const threshold = 60; // 端から60px以内でスクロール発動
  const scrollSpeed = 16; // 1フレームあたりのスクロール量

  // 下端付近判定
  if (lastPointerClientY > rect.bottom - threshold && lastPointerClientY <= rect.bottom + 40) {
    calendarContainer.scrollTop += scrollSpeed;
    updateDragFromCurrentPointer();
  }
  // 上端付近判定
  else if (lastPointerClientY < rect.top + threshold && lastPointerClientY >= rect.top - 40) {
    calendarContainer.scrollTop -= scrollSpeed;
    updateDragFromCurrentPointer();
  }
}

function startAutoScroll() {
  if (!autoScrollTimer) {
    autoScrollTimer = setInterval(checkAutoScroll, 20); // 50fps
  }
}

function stopAutoScroll() {
  if (autoScrollTimer) {
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

function updateDragFromCurrentPointer() {
  // 自動スクロール中に現在の指/マウス位置のセルを再評価
  const currentX = window.lastPointerClientX || 0;
  const currentY = lastPointerClientY;
  const point = getSlotAndDayFromPoint(currentX, currentY);
  if (point && dragStart && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    updateActiveDragOverlay();
  }
}

function updateActiveDragOverlay() {
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (!dragStart || !dragCurrent) return;

  const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
  const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);
  const targetCol = gridBody.querySelector(`.day-column[data-day-index="${dragStart.dayIndex}"]`);
  if (!targetCol) return;

  const topPx = minSlot * CELL_HEIGHT;
  const heightPx = (maxSlot - minSlot + 1) * CELL_HEIGHT;

  const startTimeStr = formatTime(minSlot);
  const endTimeStr = formatTime(maxSlot + 1);

  const overlay = document.createElement('div');
  overlay.className = 'selection-overlay';
  overlay.style.top = `${topPx}px`;
  overlay.style.height = `${heightPx}px`;
  overlay.style.left = '3px';
  overlay.style.right = '3px';

  overlay.innerHTML = `
    <div class="sel-title">時間帯を指定中...</div>
    <div class="sel-time">${startTimeStr} 〜 ${endTimeStr}</div>
  `;
  targetCol.appendChild(overlay);
}

function handlePointerDown(e) {
  if (e.target.closest('.del-btn') || e.target.closest('.committed-block') || e.target.closest('.pending-block')) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  window.lastPointerClientX = clientX;
  lastPointerClientY = clientY;

  const point = getSlotAndDayFromPoint(clientX, clientY);
  if (point) {
    isDragging = true;
    dragStart = point;
    dragCurrent = point;
    updateActiveDragOverlay();
    startAutoScroll();
  }
}

function handlePointerMove(e) {
  if (!isDragging || !dragStart) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  window.lastPointerClientX = clientX;
  lastPointerClientY = clientY;

  const point = getSlotAndDayFromPoint(clientX, clientY);
  if (point && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    updateActiveDragOverlay();
  }
}

function handlePointerUp() {
  if (!isDragging) return;
  isDragging = false;
  stopAutoScroll();

  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (dragStart && dragCurrent) {
    const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
    const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);

    const defaultTitle = calendarSelect.options[calendarSelect.selectedIndex] 
      ? calendarSelect.options[calendarSelect.selectedIndex].text.split(' ')[0] + ' 予定'
      : '予定';

    const newPendingData = {
      id: 'pending-' + Date.now() + Math.random(),
      dayIndex: dragStart.dayIndex,
      dateStr: dragStart.dateStr,
      startSlot: minSlot,
      endSlot: maxSlot,
      title: defaultTitle
    };

    // 件名入力モーダルを開く
    openEditModal('create', newPendingData);
  }

  dragStart = null;
  dragCurrent = null;
}

// ==========================================
// モーダル操作ロジック
// ==========================================
function openEditModal(mode, data) {
  editingTarget = { mode, data };
  const startTimeStr = formatTime(data.startSlot);
  const endTimeStr = formatTime(data.endSlot + 1);

  modalTitle.textContent = mode === 'create' ? '予定の件名を入力' : '件名を編集';
  modalTimeRange.textContent = `📅 ${data.dateStr}  ⏰ ${startTimeStr} 〜 ${endTimeStr}`;
  eventTitleInput.value = data.title || '';

  modalOverlay.classList.add('open');

  // インプットにフォーカス & テキスト全選択（ワンキーで上書き可能に）
  setTimeout(() => {
    eventTitleInput.focus();
    eventTitleInput.select();
  }, 100);
}

function closeEditModal() {
  modalOverlay.classList.remove('open');
  editingTarget = null;
}

function saveEditModal() {
  if (!editingTarget) return;

  const titleVal = eventTitleInput.value.trim() || '予定';
  const { mode, data } = editingTarget;

  if (mode === 'create') {
    data.title = titleVal;
    pendingSchedules.push(data);
  } else if (mode === 'edit') {
    const target = pendingSchedules.find(p => p.id === data.id);
    if (target) {
      target.title = titleVal;
    }
  }

  closeEditModal();
  renderWeek();
}

modalSaveBtn.addEventListener('click', saveEditModal);
modalCancelBtn.addEventListener('click', closeEditModal);
modalCloseBtn.addEventListener('click', closeEditModal);

// Enterキーで即決定、Escキーでキャンセル
eventTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveEditModal();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeEditModal();
  }
});

// モーダル外側の背景クリックで閉じる
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    closeEditModal();
  }
});

// フッターサマリー更新
function updateFooterSummary() {
  const count = pendingSchedules.length;
  if (count === 0) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Googleカレンダーへ一括登録</span>';
    selectionInfo.innerHTML = '未登録: <span>0</span> 件 (画面をなぞって予定を追加)';
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
    renderWeek();
  }
});

// ==========================================
// Googleカレンダーへまとめて一括登録 (バッチ実行)
// ==========================================
submitBtn.addEventListener('click', async () => {
  if (pendingSchedules.length === 0) return;

  const count = pendingSchedules.length;
  const calId = calendarSelect.value || 'primary';
  const calName = calendarSelect.options[calendarSelect.selectedIndex].text;

  if (!confirm(`選択された ${count} 件のスケジュールを「${calName}」へ一括登録しますか？`)) {
    return;
  }

  if (!accessToken) {
    // オフライン・モック登録
    pendingSchedules.forEach(p => {
      const startTimeStr = formatTime(p.startSlot);
      const endTimeStr = formatTime(p.endSlot + 1);
      const [sH, sM] = startTimeStr.split(':').map(Number);
      const [eH, eM] = endTimeStr.split(':').map(Number);

      calendarEvents.push({
        id: 'local-' + Date.now() + Math.random(),
        title: p.title,
        dateStr: p.dateStr,
        startHour: sH,
        startMin: sM,
        endHour: eH,
        endMin: eM,
        category: 'work'
      });
    });

    pendingSchedules = [];
    showToast(`（モック）${count} 件の予定を一括登録しました！`);
    renderWeek();
    return;
  }

  // Google Calendar API 本番並列送信
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span>⏳ ${count} 件を送信中...</span>`;

  try {
    const promises = pendingSchedules.map(p => {
      const startTimeStr = formatTime(p.startSlot);
      const endTimeStr = formatTime(p.endSlot + 1);
      const startDateTime = `${p.dateStr}T${startTimeStr}:00+09:00`;
      const endDateTime = `${p.dateStr}T${endTimeStr}:00+09:00`;

      return fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
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
    showToast(`⚡ ${successCount} 件のスケジュールをGoogleカレンダーへ一括登録完了！`);
    await loadCalendarEvents();
  } catch (err) {
    console.error('Batch insert error', err);
    showToast('一括登録中にエラーが発生しました');
  } finally {
    submitBtn.disabled = false;
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
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

nextWeekBtn.addEventListener('click', () => {
  currentWeekOffset++;
  renderWeek();
  if (accessToken) loadCalendarEvents();
});

// イベントリスナー登録
gridBody.addEventListener('touchstart', handlePointerDown, { passive: false });
gridBody.addEventListener('touchmove', handlePointerMove, { passive: false });
window.addEventListener('touchend', handlePointerUp);

gridBody.addEventListener('mousedown', handlePointerDown);
window.addEventListener('mousemove', handlePointerMove);
window.addEventListener('mouseup', handlePointerUp);

// 初期化
initTimeLabels();
renderWeek();
initGoogleAuth();
